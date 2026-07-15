'use client';

/**
 * Global store for the one-click MP4 render (issue #866).
 *
 * The render is async and long (a 10-minute classroom takes ~10 minutes), so
 * its progress must outlive the export menu: the user can close the menu, switch
 * scenes, and reopen the menu, and still see live progress. Keeping the state in
 * a component (as the first cut did) meant it died with the menu, and the
 * re-mounted menu reset its "already rendering" ref — letting the user submit a
 * duplicate render. Hoisting the whole lifecycle here fixes both.
 *
 * The store owns the submit → poll → download loop. Progress is a percentage
 * plus an estimated time remaining (extrapolated from elapsed time and smoothed
 * with an EMA); no producer stage strings are surfaced. i18n stays out of the
 * store: callers pass `t`, and toasts use sonner's global singleton so they
 * still fire if the calling component has unmounted.
 */
import { create } from 'zustand';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { createLogger } from '@/lib/logger';
import { runPolledTask } from '@/lib/media/polled-task';
import {
  buildExportZip,
  NoScenesError,
  sanitizeFilename,
  type VideoFps,
  type VideoQuality,
  type VideoResolution,
} from '@/lib/video-export-app/build-export-zip';

const log = createLogger('VideoRenderStore');

const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = Math.ceil((60 * 60 * 1000) / POLL_INTERVAL_MS);
/** Below this percent the extrapolated ETA is too noisy to show. */
const ETA_MIN_PERCENT = 3;
/**
 * EMA weight for the newest *speed* sample (percent-per-ms). Lower = smoother
 * and laggier. We smooth speed rather than the whole-run average because this
 * render is not uniform (prep → frame capture, which drops 4→1 worker mid-way,
 * → encode): a recent-speed estimate reacts to those regime changes, and the
 * EMA keeps it from jittering on the producer's uneven percent updates.
 */
const SPEED_SMOOTHING = 0.3;

export type VideoRenderStatus = 'idle' | 'compiling' | 'rendering' | 'succeeded' | 'failed';

/** Minimal i18n surface the store needs, injected by callers. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

export interface RenderOptions {
  resolution?: VideoResolution;
  fps?: VideoFps;
  quality?: VideoQuality;
}

/** Fully-resolved render options (the store always holds concrete values). */
type ResolvedOptions = Required<RenderOptions>;

const DEFAULT_OPTIONS: ResolvedOptions = {
  resolution: '1080p',
  fps: 30,
  quality: 'standard',
};

interface JobStatusResponse {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  currentStage?: string;
  error?: string;
  done?: boolean;
}

interface VideoRenderState {
  status: VideoRenderStatus;
  /** 0..100. */
  percent: number;
  /** Estimated milliseconds remaining, or null while unknown. */
  etaMs: number | null;
  filename: string | null;
  error: string | null;
  /**
   * The user's selected render options. Held in the store (not the menu
   * component) so they survive the menu unmounting on scene switches and, while
   * a render runs, reflect the options that render is actually using.
   */
  options: ResolvedOptions;
  setOptions: (patch: Partial<ResolvedOptions>) => void;
  /** True while a render is in flight (compiling or rendering). */
  isActive: () => boolean;
  startRender: (t: Translate) => Promise<void>;
  reset: () => void;
}

/** Whether a status means a render is still in flight. */
function inFlight(status: VideoRenderStatus): boolean {
  return status === 'compiling' || status === 'rendering';
}

export const useVideoRenderStore = create<VideoRenderState>()((set, get) => ({
  status: 'idle',
  percent: 0,
  etaMs: null,
  filename: null,
  error: null,
  options: DEFAULT_OPTIONS,

  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

  isActive: () => inFlight(get().status),

  reset: () => set({ status: 'idle', percent: 0, etaMs: null, filename: null, error: null }),

  startRender: async (t) => {
    // Guard against a duplicate submit — the whole reason state lives here.
    if (inFlight(get().status)) return;

    const { resolution, fps, quality } = get().options;

    set({ status: 'compiling', percent: 0, etaMs: null, filename: null, error: null });
    const toastId = toast.loading(t('export.videoCompiling'));

    let zipBlob: Blob;
    let stageName: string;
    let missingCount = 0;
    let errorCount = 0;
    try {
      const built = await buildExportZip(resolution);
      ({ zipBlob, stageName, missingCount, errorCount } = built);
    } catch (error) {
      if (error instanceof NoScenesError) {
        toast.error(t('export.videoNoScenes'), { id: toastId });
      } else {
        log.error('Video render (compile) failed:', error);
        toast.error(t('export.videoFailed'), { id: toastId });
      }
      set({ status: 'failed', error: 'compile' });
      return;
    }

    const filename = `${sanitizeFilename(stageName)}.mp4`;
    set({ status: 'rendering', filename });

    // ETA via recent speed: track the previous (percent, timestamp) sample,
    // derive an instantaneous percent-per-ms rate, EMA-smooth it, and project
    // the remaining percent onto it. Reacts to the render's speed regime
    // changes (worker drop, encode) far better than a whole-run average.
    let lastPercent: number | null = null;
    let lastTs = 0;
    let smoothedSpeed: number | null = null; // percent per ms

    try {
      const form = new FormData();
      form.append('project', zipBlob, 'project.zip');
      form.append('fps', String(fps));
      form.append('quality', quality);
      form.append('format', 'mp4');

      toast.loading(t('export.videoRendering'), { id: toastId });

      const mp4 = await runPolledTask<Blob>({
        label: 'render-video',
        intervalMs: POLL_INTERVAL_MS,
        maxAttempts: MAX_POLL_ATTEMPTS,
        submit: async () => {
          const res = await fetch('/api/export-video/render', { method: 'POST', body: form });
          if (res.status === 501) return { status: 'failed', message: 'not_configured' };
          const data = (await res.json().catch(() => ({}))) as { jobId?: string; error?: string };
          if (!res.ok || !data.jobId) {
            return { status: 'failed', message: data.error || `HTTP ${res.status}` };
          }
          return { status: 'submitted', taskId: data.jobId };
        },
        poll: async (jobId) => {
          const res = await fetch(`/api/export-video/render/${jobId}`);
          const data = (await res.json().catch(() => ({}))) as JobStatusResponse;
          if (!res.ok) return { status: 'failed', message: data.error || `HTTP ${res.status}` };

          const percent = Math.round((data.progress ?? 0) * 100);

          // Derive a recent speed (percent/ms) from the delta since the last
          // sample, EMA-smooth it, then project the remaining percent. Only
          // forward progress updates the speed; stalls/regressions are ignored
          // so a paused stage doesn't blow the ETA up to infinity.
          const now = Date.now();
          let etaMs = get().etaMs;
          if (lastPercent != null && percent > lastPercent && now > lastTs) {
            const sample = (percent - lastPercent) / (now - lastTs);
            smoothedSpeed =
              smoothedSpeed == null
                ? sample
                : SPEED_SMOOTHING * sample + (1 - SPEED_SMOOTHING) * smoothedSpeed;
          }
          if (percent >= ETA_MIN_PERCENT && percent < 100 && smoothedSpeed && smoothedSpeed > 0) {
            etaMs = (100 - percent) / smoothedSpeed;
          }
          if (lastPercent == null || percent > lastPercent) {
            lastPercent = percent;
            lastTs = now;
          }
          set({ percent, etaMs });

          if (data.status === 'succeeded') {
            const dl = await fetch(`/api/export-video/render/${jobId}/download`);
            if (!dl.ok) return { status: 'failed', message: `download HTTP ${dl.status}` };
            return { status: 'done', result: await dl.blob() };
          }
          if (data.status === 'failed' || data.status === 'cancelled') {
            return { status: 'failed', message: data.error || data.status };
          }
          return { status: 'pending', detail: data.currentStage };
        },
      });

      saveAs(mp4, filename);
      set({ status: 'succeeded', percent: 100, etaMs: 0 });
      toast.success(t('export.videoMp4Success'), { id: toastId });
      if (missingCount > 0 || errorCount > 0) {
        toast.warning(t('export.videoWarnings', { assets: missingCount, diagnostics: errorCount }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'not_configured') {
        // Degrade: hand back the project ZIP for local CLI rendering.
        saveAs(zipBlob, `${sanitizeFilename(stageName)}-video.zip`);
        set({ status: 'idle', percent: 0, etaMs: null });
        toast.info(t('export.videoServiceUnavailable'), { id: toastId });
      } else {
        log.error('Video render failed:', error);
        set({ status: 'failed', error: message });
        toast.error(t('export.videoFailed'), { id: toastId });
      }
    }
  },
}));

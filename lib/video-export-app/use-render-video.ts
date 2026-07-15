'use client';

/**
 * `useRenderVideo` — one-click MP4 export via the isolated render service.
 *
 * Builds the same self-contained project ZIP as {@link useExportVideo} (through
 * the shared {@link buildExportZip}), uploads it to the render service through
 * the app's thin proxy routes, polls the async render job to completion, then
 * downloads the finished MP4.
 *
 * Rendering a full classroom can take many minutes, so this is deliberately an
 * async submit → poll → download flow (not one long-lived request). Progress is
 * surfaced as a 0..100 percentage plus a stage label for the UI.
 *
 * Degrade: when the render service is not configured (proxy returns 501), fall
 * back to saving the ZIP so the user can render locally — same artifact, no
 * dead end.
 *
 * App-side / impure: store/Dexie reads, network IO, `saveAs`.
 */
import { useCallback, useRef, useState } from 'react';
import { saveAs } from 'file-saver';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { createLogger } from '@/lib/logger';
import { runPolledTask } from '@/lib/media/polled-task';
import {
  buildExportZip,
  NoScenesError,
  sanitizeFilename,
  type VideoFps,
  type VideoQuality,
  type VideoResolution,
} from './build-export-zip';

const log = createLogger('RenderVideo');

/** How often to poll job status, and the ceiling before we give up (~60 min). */
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = Math.ceil((60 * 60 * 1000) / POLL_INTERVAL_MS);

export interface RenderVideoOptions {
  resolution?: VideoResolution;
  fps?: VideoFps;
  quality?: VideoQuality;
}

export interface RenderProgress {
  /** 0..100 for a determinate progress bar. */
  percent: number;
  /** Producer stage label (e.g. "encoding"), for a caption. */
  stage: string;
}

interface JobStatusResponse {
  jobId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number;
  currentStage?: string;
  error?: string;
  done?: boolean;
}

export function useRenderVideo() {
  const [rendering, setRendering] = useState(false);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const renderingRef = useRef(false);
  const { t } = useI18n();

  const renderVideo = useCallback(
    async (options: RenderVideoOptions = {}) => {
      if (renderingRef.current) return;
      const { resolution = '1080p', fps = 30, quality = 'standard' } = options;

      renderingRef.current = true;
      setRendering(true);
      setProgress({ percent: 0, stage: 'compiling' });
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
        renderingRef.current = false;
        setRendering(false);
        setProgress(null);
        return;
      }

      const filename = `${sanitizeFilename(stageName)}.mp4`;

      try {
        const form = new FormData();
        form.append('project', zipBlob, 'project.zip');
        form.append('fps', String(fps));
        form.append('quality', quality);
        form.append('format', 'mp4');

        toast.loading(t('export.videoRendering'), { id: toastId });
        setProgress({ percent: 0, stage: 'rendering' });

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
            setProgress({ percent, stage: data.currentStage || data.status });

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
        toast.success(t('export.videoMp4Success'), { id: toastId });
        if (missingCount > 0 || errorCount > 0) {
          toast.warning(
            t('export.videoWarnings', { assets: missingCount, diagnostics: errorCount }),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'not_configured') {
          // Degrade: hand back the project ZIP for local CLI rendering.
          saveAs(zipBlob, `${sanitizeFilename(stageName)}-video.zip`);
          toast.info(t('export.videoServiceUnavailable'), { id: toastId });
        } else {
          log.error('Video render failed:', error);
          toast.error(t('export.videoFailed'), { id: toastId });
        }
      } finally {
        renderingRef.current = false;
        setRendering(false);
        setProgress(null);
      }
    },
    [t],
  );

  return { rendering, progress, renderVideo };
}

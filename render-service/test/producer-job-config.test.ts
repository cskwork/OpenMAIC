import type { RenderJob } from '@hyperframes/producer';
import { describe, expect, it } from 'vitest';
import {
  assertRequiredCaptureMode,
  assertRequiredCaptureModeIfObserved,
  buildProducerJobConfig,
  buildRenderExecutionMetrics,
  buildRenderExecutionMetricsFromJob,
} from '../src/render-manager.js';

describe('buildProducerJobConfig', () => {
  const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;

  it('passes the configured worker count as an explicit producer job option', () => {
    expect(buildProducerJobConfig(options, 4)).toEqual({ ...options, workers: 4 });
  });

  it('keeps one worker explicit so producer auto-parallel thresholds cannot raise it', () => {
    expect(buildProducerJobConfig(options, 1)).toEqual({ ...options, workers: 1 });
  });

  it('uses the selected profile worker count when no override is supplied', () => {
    expect(buildProducerJobConfig(options)).toEqual({ ...options, workers: 1 });
  });

  it('rejects a required beginFrame profile when workers report screenshot mode', () => {
    expect(() => assertRequiredCaptureMode('screenshot', true)).toThrow(/beginFrame/i);
    expect(() => assertRequiredCaptureMode('beginframe|screenshot', true)).toThrow(/beginFrame/i);
    expect(() => assertRequiredCaptureMode(undefined, true)).toThrow(/beginFrame/i);
  });

  it('accepts the resolved beginFrame mode and does nothing when not required', () => {
    expect(() => assertRequiredCaptureMode('beginframe', true)).not.toThrow();
    expect(() => assertRequiredCaptureMode('screenshot', false)).not.toThrow();
  });

  it('preserves the producer failure until capture mode has actually been observed', () => {
    expect(() => assertRequiredCaptureModeIfObserved('unknown', true)).not.toThrow();
    expect(() => assertRequiredCaptureModeIfObserved('screenshot', true)).toThrow(/beginFrame/i);
  });
});

describe('buildRenderExecutionMetrics', () => {
  const versions = {
    service: '0.1.0',
    producer: '0.7.60',
    node: 'v22.22.2',
    chromium: 'Chromium 151.0.7922.71',
    chromiumPath: '/usr/bin/chromium-headless-shell',
    ffmpeg: 'ffmpeg version 5.1.9-0+deb12u1',
    ffmpegPath: '/usr/bin/ffmpeg',
    containerImage: 'openmaic/render-service:test',
  };

  it('reports the requested profile, actual producer selection, and runtime versions', () => {
    expect(buildRenderExecutionMetrics('beginframe', 1, versions)).toEqual({
      resourceProfile: 'standard',
      requestedCaptureMode: 'beginframe',
      actualCaptureMode: 'beginframe',
      requestedWorkers: 1,
      actualWorkers: 1,
      versions,
    });
  });

  it('does not treat request observability as actual mode on hard failure', () => {
    const failedJob = {
      errorDetails: {
        message: 'Target closed',
        elapsedMs: 1000,
        freeMemoryMB: 1024,
        observability: {
          events: [],
          eventCount: 1,
          browserDiagnostics: {
            total: 1,
            errors: 1,
            pageErrors: 1,
            requestFailed: 0,
            httpErrors: 0,
            navigationStarts: 1,
            navigationFailures: 0,
            consoleErrors: 0,
            consoleWarnings: 0,
          },
          capture: {
            forceScreenshot: false,
            captureMode: 'beginframe',
            workerCount: 1,
          },
        },
      },
    } satisfies Pick<RenderJob, 'perfSummary' | 'errorDetails'>;

    expect(buildRenderExecutionMetricsFromJob(failedJob, versions)).toMatchObject({
      actualCaptureMode: 'unknown',
      actualWorkers: 1,
    });
  });

  it('keeps a confirmed screenshot result available for the required-mode guard', () => {
    const failedJob = {
      errorDetails: {
        message: 'Target closed',
        elapsedMs: 1000,
        freeMemoryMB: 1024,
        observability: {
          events: [
            {
              phase: 'capture_disk',
              status: 'error',
              elapsedMs: 1000,
              data: { captureMode: 'screenshot', workerCount: 1 },
            },
          ],
          eventCount: 1,
          browserDiagnostics: {
            total: 0,
            errors: 0,
            pageErrors: 0,
            requestFailed: 0,
            httpErrors: 0,
            navigationStarts: 0,
            navigationFailures: 0,
            consoleErrors: 0,
            consoleWarnings: 0,
          },
          capture: {
            forceScreenshot: false,
            captureMode: 'beginframe',
            workerCount: 1,
          },
        },
      },
    } satisfies Pick<RenderJob, 'perfSummary' | 'errorDetails'>;

    const metrics = buildRenderExecutionMetricsFromJob(failedJob, versions);
    expect(metrics.actualCaptureMode).toBe('screenshot');
    expect(() => assertRequiredCaptureModeIfObserved(metrics.actualCaptureMode, true)).toThrow(
      /beginFrame/i,
    );
  });

  it('treats a forced HDR layered capture as screenshot despite the outer probe mode', () => {
    const failedJob = {
      errorDetails: {
        message: 'Target closed',
        elapsedMs: 1000,
        freeMemoryMB: 1024,
        observability: {
          events: [
            {
              phase: 'capture_hdr_layered',
              status: 'error',
              elapsedMs: 1000,
              data: { forceScreenshot: true, captureMode: 'beginframe', workerCount: 1 },
            },
          ],
          eventCount: 1,
          browserDiagnostics: {
            total: 0,
            errors: 0,
            pageErrors: 0,
            requestFailed: 0,
            httpErrors: 0,
            navigationStarts: 0,
            navigationFailures: 0,
            consoleErrors: 0,
            consoleWarnings: 0,
          },
          capture: {
            forceScreenshot: true,
            captureMode: 'screenshot',
            workerCount: 1,
          },
        },
      },
    } satisfies Pick<RenderJob, 'perfSummary' | 'errorDetails'>;

    const metrics = buildRenderExecutionMetricsFromJob(failedJob, versions);
    expect(metrics.actualCaptureMode).toBe('screenshot');
    expect(() => assertRequiredCaptureModeIfObserved(metrics.actualCaptureMode, true)).toThrow(
      /beginFrame/i,
    );
  });
});

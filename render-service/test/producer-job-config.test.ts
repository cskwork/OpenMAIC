import { describe, expect, it } from 'vitest';
import {
  assertRequiredCaptureMode,
  buildProducerJobConfig,
  buildRenderExecutionMetrics,
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
});

describe('buildRenderExecutionMetrics', () => {
  it('reports the requested profile, actual producer selection, and runtime versions', () => {
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

    expect(buildRenderExecutionMetrics('beginframe', 1, versions)).toEqual({
      resourceProfile: 'standard',
      requestedCaptureMode: 'beginframe',
      actualCaptureMode: 'beginframe',
      requestedWorkers: 1,
      actualWorkers: 1,
      versions,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildProducerJobConfig } from '../src/render-manager.js';

describe('buildProducerJobConfig', () => {
  const options = { fps: 30, quality: 'standard', format: 'mp4' } as const;

  it('passes the configured worker count as an explicit producer job option', () => {
    expect(buildProducerJobConfig(options, 4)).toEqual({ ...options, workers: 4 });
  });

  it('keeps one worker explicit so producer auto-parallel thresholds cannot raise it', () => {
    expect(buildProducerJobConfig(options, 1)).toEqual({ ...options, workers: 1 });
  });
});

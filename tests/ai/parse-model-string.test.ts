import { describe, expect, it } from 'vitest';
import { parseModelString } from '@/lib/ai/providers';

describe('parseModelString', () => {
  it('splits provider and model on first colon', () => {
    expect(parseModelString('anthropic:claude-sonnet-4-6')).toEqual({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
  });

  it('handles model IDs containing colons (split on first only)', () => {
    expect(parseModelString('siliconflow:deepseek-ai/DeepSeek-V3')).toEqual({
      providerId: 'siliconflow',
      modelId: 'deepseek-ai/DeepSeek-V3',
    });
  });

  it('defaults to openai when no colon present', () => {
    expect(parseModelString('gpt-4o')).toEqual({
      providerId: 'openai',
      modelId: 'gpt-4o',
    });
  });

  it('defaults to openai for empty string', () => {
    expect(parseModelString('')).toEqual({
      providerId: 'openai',
      modelId: '',
    });
  });

  it('handles colon at position 0 (empty provider) as default openai', () => {
    // colonIndex === 0, so condition `colonIndex > 0` is false
    expect(parseModelString(':some-model')).toEqual({
      providerId: 'openai',
      modelId: ':some-model',
    });
  });
});

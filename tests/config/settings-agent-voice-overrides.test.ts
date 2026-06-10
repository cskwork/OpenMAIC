/**
 * agentVoiceOverrides: persisted per-agent voice picks (the UI-preference home
 * for AgentBar voice selection — registry agent records are reset from
 * code/IndexedDB on every load and must not own user picks).
 */
import { describe, it, expect } from 'vitest';
import { useSettingsStore } from '@/lib/store/settings';

describe('agentVoiceOverrides', () => {
  it('defaults to an empty map', () => {
    expect(useSettingsStore.getState().agentVoiceOverrides).toEqual({});
  });

  it('setAgentVoiceOverride adds and replaces entries per agent id', () => {
    const { setAgentVoiceOverride } = useSettingsStore.getState();
    setAgentVoiceOverride('default-2', { providerId: 'qwen-tts', voiceId: 'Dylan' });
    setAgentVoiceOverride('default-3', {
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Cherry',
    });
    setAgentVoiceOverride('default-2', { providerId: 'qwen-tts', voiceId: 'Serena' });
    expect(useSettingsStore.getState().agentVoiceOverrides).toEqual({
      'default-2': { providerId: 'qwen-tts', voiceId: 'Serena' },
      'default-3': { providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
    });
  });
});

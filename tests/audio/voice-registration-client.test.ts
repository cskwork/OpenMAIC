import { describe, it, expect, vi, beforeEach } from 'vitest';

// db is browser-only (Dexie); stub it so the client module loads in node.
vi.mock('@/lib/utils/database', () => ({
  db: {
    autoVoiceCache: {
      get: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    },
  },
}));

import { ensureRegisteredVoice } from '@/lib/audio/voice-registration-client';

function okFetch() {
  const f = vi.fn(
    async () => new Response(JSON.stringify({ voiceId: 'x', registered: true }), { status: 200 }),
  );
  vi.stubGlobal('fetch', f);
  return f;
}

describe('ensureRegisteredVoice memoization', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('re-registers when the backend base URL changes (memo keyed by backend, not voiceId alone)', async () => {
    const f = okFetch();
    // Distinct descriptor per test so the module-level memo from other tests can't collide.
    const voiceDesign = { identity: 'backend-switch teacher', texture: 'warm', delivery: 'calm' };

    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsBaseUrl: 'https://a.test/v1' });
    // Same backend again → memoized, no second round-trip.
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsBaseUrl: 'https://a.test/v1' });
    expect(f).toHaveBeenCalledTimes(1);

    // Different backend → must NOT be skipped by the memo; re-register there.
    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, { ttsBaseUrl: 'https://b.test/v1' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent calls for the same (voiceId, backend) into one request', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'concurrent teacher', texture: 'warm', delivery: 'calm' };
    const req = { ttsBaseUrl: 'https://c.test/v1' };

    await Promise.all([
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
      ensureRegisteredVoice('voxcpm-tts', { voiceDesign }, req),
    ]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('re-registers when the API key changes on the same base URL (auth-scoped)', async () => {
    const f = okFetch();
    const voiceDesign = {
      identity: 'credential-switch teacher',
      texture: 'warm',
      delivery: 'calm',
    };
    const base = 'https://d.test/v1';

    await ensureRegisteredVoice(
      'voxcpm-tts',
      { voiceDesign },
      { ttsBaseUrl: base, ttsApiKey: 'k1' },
    );
    await ensureRegisteredVoice(
      'voxcpm-tts',
      { voiceDesign },
      { ttsBaseUrl: base, ttsApiKey: 'k1' },
    );
    expect(f).toHaveBeenCalledTimes(1); // same creds → memoized

    await ensureRegisteredVoice(
      'voxcpm-tts',
      { voiceDesign },
      { ttsBaseUrl: base, ttsApiKey: 'k2' },
    );
    expect(f).toHaveBeenCalledTimes(2); // different creds → re-validate
  });

  it('sends the refText to the registration endpoint and scopes the voice id by it', async () => {
    const f = okFetch();
    const voiceDesign = { identity: 'refText teacher', texture: 'warm', delivery: 'calm' };
    const req = { ttsBaseUrl: 'https://e.test/v1' };
    const refText = '大家好，我是这门课的老师，欢迎来到课堂，我们马上开始今天的学习。';

    await ensureRegisteredVoice('voxcpm-tts', { voiceDesign, refText }, req);
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.refText).toBe(refText);

    // A different seed script is a different reference clip → separate registration.
    await ensureRegisteredVoice(
      'voxcpm-tts',
      { voiceDesign, refText: refText + '今天我们学新内容。' },
      req,
    );
    expect(f).toHaveBeenCalledTimes(2);
    const ids = f.mock.calls.map(
      (call) => JSON.parse(String((call as unknown as [string, RequestInit])[1].body)).voiceId,
    );
    expect(ids[0]).not.toBe(ids[1]);
  });
});

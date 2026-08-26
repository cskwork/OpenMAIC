import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ configured: false }));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => flags.configured,
}));

import { GET } from '@/app/api/agent/runtime/route';

beforeEach(() => {
  flags.configured = false;
});

describe('agent runtime probe', () => {
  it('reports an unconfigured runtime as disabled', async () => {
    await expect((await GET()).json()).resolves.toEqual({ enabled: false });
  });

  it('reports the configured runtime without unrelated capability flags', async () => {
    flags.configured = true;
    await expect((await GET()).json()).resolves.toEqual({ enabled: true });
  });
});

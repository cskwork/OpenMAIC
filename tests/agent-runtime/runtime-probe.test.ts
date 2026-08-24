import { beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ runtime: false }));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => flags.runtime,
}));

import { GET } from '@/app/api/agent/runtime/route';

beforeEach(() => {
  flags.runtime = false;
});

describe('agent runtime probe', () => {
  it('reports the disabled runtime', async () => {
    await expect((await GET()).json()).resolves.toEqual({ enabled: false });
  });

  it('reports the enabled runtime without unrelated capability flags', async () => {
    flags.runtime = true;
    await expect((await GET()).json()).resolves.toEqual({ enabled: true });
  });
});

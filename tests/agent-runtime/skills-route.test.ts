import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  listSkills: vi.fn(),
  isAgentRuntimeEnabled: vi.fn(() => true),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: mocks.isAgentRuntimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/skills', () => ({ listSkills: mocks.listSkills }));

import { GET } from '@/app/api/agent/skills/route';

const request = () => new NextRequest('http://localhost/api/agent/skills');

/** The route's owner seam: run the handler with a fixed owner + header bag. */
function runWithOwner(ownerId: string) {
  mocks.withRequestOwnerId.mockImplementation(
    async (
      _req: NextRequest,
      handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    ) => handler(ownerId, new Headers()),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  runWithOwner('user:u1');
  mocks.listSkills.mockResolvedValue([
    {
      id: 'builtin',
      name: 'builtin',
      title: 'Builtin',
      description: 'builtin',
      constraints: null,
      source: 'builtin',
    },
    {
      id: 'usk_1',
      name: 'my-demo',
      title: 'My method',
      description: 'demo',
      constraints: null,
      source: 'user',
    },
  ]);
});

describe('GET agent skills', () => {
  it('lists builtin and current-owner skills with stable id and readable handle', async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.listSkills).toHaveBeenCalledWith('user:u1');
    await expect(response.json()).resolves.toMatchObject([
      { id: 'builtin', name: 'builtin', source: 'builtin' },
      { id: 'usk_1', name: 'my-demo', source: 'user' },
    ]);
  });

  it('returns 404 when the runtime flag is off', async () => {
    mocks.isAgentRuntimeEnabled.mockReturnValueOnce(false);
    expect((await GET(request())).status).toBe(404);
    expect(mocks.listSkills).not.toHaveBeenCalled();
  });
});

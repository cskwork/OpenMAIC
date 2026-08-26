import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  withRequestOwnerId: vi.fn(),
  findUserSkill: vi.fn(),
}));
vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => true,
  isAgentRuntimeConfigured: () => true,
}));
vi.mock('@/lib/server/agent-runtime/with-owner', () => ({
  withRequestOwnerId: mocks.withRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/user-skills', () => ({
  findUserSkill: mocks.findUserSkill,
}));

import { GET } from '@/app/api/agent/skills/[id]/route';

const request = () => new NextRequest('http://localhost/api/agent/skills/usk_1');
const context = { params: Promise.resolve({ id: 'usk_1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withRequestOwnerId.mockImplementation(
    async (
      _req: NextRequest,
      handler: (ownerId: string, responseHeaders: Headers) => Promise<Response>,
    ) => handler('user:u1', new Headers()),
  );
  mocks.findUserSkill.mockResolvedValue({
    id: 'usk_1',
    content: '# Full body\n\nNone of it missing',
  });
});

describe('GET agent skill detail', () => {
  it('returns the complete body only for the current owner', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.findUserSkill).toHaveBeenCalledWith('usk_1', 'user:u1');
    await expect(response.json()).resolves.toEqual({
      id: 'usk_1',
      content: '# Full body\n\nNone of it missing',
    });
  });

  it('uses the same 404 for an absent or foreign Skill', async () => {
    mocks.findUserSkill.mockResolvedValue(null);
    expect((await GET(request(), context)).status).toBe(404);
  });
});

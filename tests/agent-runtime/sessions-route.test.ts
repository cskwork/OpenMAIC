import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  createSession: vi.fn(),
  listSessionsByOwner: vi.fn(),
  resolveRequestOwnerId: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    createSession: mocks.createSession,
    listSessionsByOwner: mocks.listSessionsByOwner,
  }),
}));

import { GET, POST } from '@/app/api/agent/sessions/route';

function post(body: unknown, headers?: HeadersInit) {
  return POST(
    new NextRequest('http://localhost/api/agent/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.resolveRequestOwnerId.mockImplementation(
    (_request: NextRequest, responseHeaders: Headers) => {
      responseHeaders.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
      return 'anon:test';
    },
  );
  mocks.createSession.mockResolvedValue({
    id: 'session-1',
    ownerId: 'anon:test',
    prompt: 'Build a course',
    stageId: 'agent-session-1',
    status: 'queued',
  });
  mocks.listSessionsByOwner.mockResolvedValue([]);
});

describe('agent session collection route', () => {
  it('creates a queued session and propagates a newly minted owner cookie', async () => {
    const response = await post({ prompt: ' Build a course ', skill: 'custom-skill' });

    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'anon:test',
        prompt: 'Build a course',
        skillId: 'custom-skill',
        existingCourse: false,
        origin: 'http://localhost',
      }),
    );
  });

  it('requires a prompt for a new session', async () => {
    const response = await post({ prompt: '  ' });

    expect(response.status).toBe(400);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('creates an idle existing-course session without a stage access dependency', async () => {
    const response = await post({ existingCourse: true, stageId: 'stage-1' });

    expect(response.status).toBe(202);
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'stage-1',
        stageId: 'stage-1',
        existingCourse: true,
        status: 'succeeded',
      }),
    );
  });

  it('requires a stage id for an existing-course session', async () => {
    const response = await post({ existingCourse: true });

    expect(response.status).toBe(400);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('lists only sessions for the resolved owner', async () => {
    mocks.listSessionsByOwner.mockResolvedValue([{ id: 'session-1', status: 'running' }]);
    const response = await GET(new NextRequest('http://localhost/api/agent/sessions'));

    expect(response.status).toBe(200);
    expect(mocks.listSessionsByOwner).toHaveBeenCalledWith('anon:test');
    await expect(response.json()).resolves.toEqual([{ id: 'session-1', status: 'running' }]);
  });

  it('keeps both collection methods behind the runtime gate', async () => {
    mocks.runtimeEnabled = false;

    expect((await post({ prompt: 'Build' })).status).toBe(404);
    expect((await GET(new NextRequest('http://localhost/api/agent/sessions'))).status).toBe(404);
    expect(mocks.resolveRequestOwnerId).not.toHaveBeenCalled();
  });
});

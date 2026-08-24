import { AgentSessionAccessError } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  postUserMessage: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({ isAgentRuntimeEnabled: () => true }));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: (_request: NextRequest, headers: Headers) => {
    headers.append('Set-Cookie', 'anonymous_id=test; Path=/; HttpOnly');
    return 'owner-1';
  },
}));
vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: async () => ({
    getSession: mocks.getSession,
    postUserMessage: mocks.postUserMessage,
  }),
}));

import { POST } from '@/app/api/agent/sessions/[id]/messages/route';
import { MAX_SESSION_TEXT_LENGTH } from '@/lib/server/agent-runtime/limits';

function call(body: unknown) {
  const request = new NextRequest('http://localhost/api/agent/sessions/session-1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return POST(request, { params: Promise.resolve({ id: 'session-1' }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-1', status: 'succeeded' });
  mocks.postUserMessage.mockResolvedValue({ seq: 4, delivery: 'queued', requeued: true });
});

describe('POST agent session message', () => {
  it('posts a trimmed message with an owner fence and returns its delivery', async () => {
    const response = await call({ text: ' Continue ' });

    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).toHaveBeenCalledWith(
      'session-1',
      { text: 'Continue' },
      { expectedOwnerId: 'owner-1' },
    );
    await expect(response.json()).resolves.toEqual({
      id: 'session-1',
      message: { seq: 4, text: 'Continue', delivery: 'queued' },
    });
  });

  it('accepts a follow-up for a failed session', async () => {
    mocks.getSession.mockResolvedValue({
      id: 'session-1',
      ownerId: 'owner-1',
      status: 'failed',
      attempt: 6,
    });

    expect((await call({ text: 'Retry' })).status).toBe(202);
    expect(mocks.postUserMessage).toHaveBeenCalledOnce();
  });

  it('requires non-empty text', async () => {
    const response = await call({ text: ' ' });

    expect(response.status).toBe(400);
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('rejects a message that exceeds the text length cap', async () => {
    const response = await call({ text: 'x'.repeat(MAX_SESSION_TEXT_LENGTH + 1) });

    expect(response.status).toBe(400);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('hides an absent or foreign session', async () => {
    mocks.getSession.mockResolvedValue({ id: 'session-1', ownerId: 'owner-2' });

    const response = await call({ text: 'Continue' });
    expect(response.status).toBe(404);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
    expect(mocks.postUserMessage).not.toHaveBeenCalled();
  });

  it('keeps the minted owner cookie when the store fails', async () => {
    mocks.getSession.mockRejectedValue(new Error('database unavailable'));

    const response = await call({ text: 'Continue' });

    expect(response.status).toBe(500);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });

  it('maps a transactional ownership race to forbidden', async () => {
    mocks.postUserMessage.mockRejectedValue(new AgentSessionAccessError('session-1'));

    const response = await call({ text: 'Continue' });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toContain('anonymous_id=test');
  });
});

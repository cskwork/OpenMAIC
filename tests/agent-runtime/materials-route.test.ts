import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { AgentSessionMaterial } from '@openmaic/storage';

const mocks = vi.hoisted(() => ({
  runtimeEnabled: true,
  resolveRequestOwnerId: vi.fn(),
  resolveOwnedSession: vi.fn(),
  listSessionMaterials: vi.fn(),
  createSourceMaterial: vi.fn(),
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeEnabled: () => mocks.runtimeEnabled,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/server/agent-runtime/session-materials', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/agent-runtime/session-materials')>();
  return {
    ...actual,
    resolveOwnedSession: mocks.resolveOwnedSession,
    listSessionMaterials: mocks.listSessionMaterials,
    createSourceMaterial: mocks.createSourceMaterial,
  };
});

import { GET, POST } from '@/app/api/materials/route';

const SESSION_ID = 'session-1';

function material(overrides: Partial<AgentSessionMaterial> = {}): AgentSessionMaterial {
  return {
    id: 'mat_00000000000000000000000000',
    sessionId: SESSION_ID,
    kind: 'web',
    title: 'Example',
    sourceUrl: 'https://example.com/doc',
    textAssetId: 'asset-1',
    rawAssetId: null,
    textChars: 42,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeEnabled = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.resolveOwnedSession.mockResolvedValue({ id: SESSION_ID, ownerId: 'owner-1' });
  mocks.listSessionMaterials.mockResolvedValue([material()]);
  mocks.createSourceMaterial.mockImplementation(
    async (_sessionId: string, input: { filename: string; mimeType: string; bytes: Buffer }) =>
      material({ kind: 'source', title: input.filename }),
  );
});

describe('GET /api/materials', () => {
  it("lists one owned session's materials as public views", async () => {
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      materials: [
        {
          materialId: 'mat_00000000000000000000000000',
          kind: 'web',
          title: 'Example',
          sourceUrl: 'https://example.com/doc',
          textChars: 42,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(mocks.resolveOwnedSession).toHaveBeenCalledWith(SESSION_ID, 'owner-1');
    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID, {});
  });

  it('passes limit and before through as keyset paging', async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/materials?sessionId=${SESSION_ID}&limit=10&before=mat_prev`,
      ),
    );
    expect(response.status).toBe(200);
    expect(mocks.listSessionMaterials).toHaveBeenCalledWith(SESSION_ID, {
      limit: 10,
      before: 'mat_prev',
    });
  });

  it('rejects a missing sessionId', async () => {
    const response = await GET(new NextRequest('http://localhost/api/materials'));
    expect(response.status).toBe(400);
    expect(mocks.resolveOwnedSession).not.toHaveBeenCalled();
  });

  it('rejects a malformed or out-of-range limit', async () => {
    for (const limit of ['abc', '0', '201']) {
      const response = await GET(
        new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}&limit=${limit}`),
      );
      expect(response.status).toBe(400);
    }
  });

  it('answers 404 for a foreign or missing session (no existence oracle)', async () => {
    mocks.resolveOwnedSession.mockResolvedValue(null);
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(404);
    expect(mocks.listSessionMaterials).not.toHaveBeenCalled();
  });

  it('answers 404 when the agent runtime is disabled', async () => {
    mocks.runtimeEnabled = false;
    const response = await GET(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`),
    );
    expect(response.status).toBe(404);
  });
});

describe('POST /api/materials', () => {
  it('uploads raw bytes as a source material', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/pdf',
          'x-material-filename': encodeURIComponent('讲义.pdf'),
        },
        body: Buffer.from('hello'),
      }),
    );
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      material: expect.objectContaining({ materialId: 'mat_00000000000000000000000000' }),
    });
    expect(mocks.createSourceMaterial).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({
        filename: '讲义.pdf',
        mimeType: 'application/pdf',
      }),
    );
    const input = mocks.createSourceMaterial.mock.calls[0]![1] as { bytes: Buffer };
    expect(Buffer.from(input.bytes).toString('utf8')).toBe('hello');
  });

  it('defaults the mime type to octet-stream when the header is absent', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'x-material-filename': 'notes.txt' },
        body: Buffer.from('text'),
      }),
    );
    expect(response.status).toBe(201);
    expect(mocks.createSourceMaterial).toHaveBeenCalledWith(
      SESSION_ID,
      expect.objectContaining({ mimeType: 'application/octet-stream' }),
    );
  });

  it('rejects a missing sessionId', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/materials', {
        method: 'POST',
        headers: { 'x-material-filename': 'a.pdf' },
        body: Buffer.from('x'),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.createSourceMaterial).not.toHaveBeenCalled();
  });

  it('rejects a missing filename header', async () => {
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: Buffer.from('x'),
      }),
    );
    expect(response.status).toBe(400);
    expect(mocks.createSourceMaterial).not.toHaveBeenCalled();
  });

  it('rejects a body over the upload cap with 413', async () => {
    const { MAX_MATERIAL_UPLOAD_BYTES } = await import('@/app/api/materials/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'x-material-filename': 'big.bin' },
        body: Buffer.alloc(MAX_MATERIAL_UPLOAD_BYTES + 1),
      }),
    );
    expect(response.status).toBe(413);
    expect(mocks.createSourceMaterial).not.toHaveBeenCalled();
  });

  it('answers 404 for a foreign or missing session', async () => {
    mocks.resolveOwnedSession.mockResolvedValue(null);
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'x-material-filename': 'a.pdf' },
        body: Buffer.from('x'),
      }),
    );
    expect(response.status).toBe(404);
    expect(mocks.createSourceMaterial).not.toHaveBeenCalled();
  });

  it('answers 500 when persisting the material fails', async () => {
    mocks.createSourceMaterial.mockRejectedValue(new Error('asset registry unavailable'));
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'x-material-filename': 'a.pdf' },
        body: Buffer.from('x'),
      }),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INTERNAL_ERROR' });
  });

  it('answers 404 when the agent runtime is disabled', async () => {
    mocks.runtimeEnabled = false;
    const response = await POST(
      new NextRequest(`http://localhost/api/materials?sessionId=${SESSION_ID}`, {
        method: 'POST',
        headers: { 'x-material-filename': 'a.pdf' },
        body: Buffer.from('x'),
      }),
    );
    expect(response.status).toBe(404);
  });
});

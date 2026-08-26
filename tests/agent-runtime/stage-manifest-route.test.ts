import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { createFakeDocumentStore } from './_fake-document-store';
import { FIXED_NOW, makeDocument, makeSlideScene } from './_stage-fixtures';

const mocks = vi.hoisted(() => ({
  runtimeConfigured: true,
  resolveRequestOwnerId: vi.fn(),
  fakeStore: null as ReturnType<typeof createFakeDocumentStore> | null,
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isAgentRuntimeConfigured: () => mocks.runtimeConfigured,
}));
vi.mock('@/lib/server/agent-runtime/owner', () => ({
  resolveRequestOwnerId: mocks.resolveRequestOwnerId,
}));
vi.mock('@/lib/persistence/server-provider', () => ({
  getServerPersistenceProvider: async () => ({ documentStore: mocks.fakeStore!.store }),
}));

import { GET } from '@/app/api/stages/[id]/manifest/route';

const STAGE_ID = 'stage-1';

function call(id = STAGE_ID) {
  const req = new NextRequest(`http://localhost/api/stages/${id}/manifest`);
  return GET(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runtimeConfigured = true;
  mocks.resolveRequestOwnerId.mockReturnValue('owner-1');
  mocks.fakeStore = createFakeDocumentStore();
});

describe('GET /api/stages/[id]/manifest', () => {
  it('returns the document rev and one entry per scene', async () => {
    mocks.fakeStore!.docs.set(
      STAGE_ID,
      makeDocument(STAGE_ID, 'Course', [
        makeSlideScene('scene-1', STAGE_ID, 1),
        makeSlideScene('scene-2', STAGE_ID, 2),
      ]),
    );

    const response = await call();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rev: FIXED_NOW,
      scenes: [
        { id: 'scene-1', order: 1, rev: FIXED_NOW },
        { id: 'scene-2', order: 2, rev: FIXED_NOW },
      ],
    });
  });

  it('reflects a new updatedAt as a new rev', async () => {
    const document = makeDocument(STAGE_ID, 'Course', [makeSlideScene('scene-1', STAGE_ID, 1)]);
    mocks.fakeStore!.docs.set(STAGE_ID, document);
    mocks.fakeStore!.docs.set(STAGE_ID, {
      ...document,
      stage: { ...document.stage, updatedAt: FIXED_NOW + 1 },
    });

    const body = await (await call()).json();
    expect(body.rev).toBe(FIXED_NOW + 1);
    expect(body.scenes[0].rev).toBe(FIXED_NOW + 1);
  });

  it('answers 404 for a missing or foreign stage', async () => {
    const response = await call('stage-absent');
    expect(response.status).toBe(404);
  });

  it('answers 404 when the agent runtime is not configured', async () => {
    mocks.runtimeConfigured = false;
    expect((await call()).status).toBe(404);
  });
});

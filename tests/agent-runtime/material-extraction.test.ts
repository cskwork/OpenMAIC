import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  PgAgentSessionStore,
  ensureAgentSessionSchema,
  type Queryable,
} from '@openmaic/storage/agent-session/pg';
import {
  PgAgentSessionMaterialStore,
  ensureAgentSessionMaterialSchema,
} from '@openmaic/storage/material/pg';

import { buildMaterialTools } from '@/lib/server/agent-runtime/material-tools';
import { extractClaimedSessionMaterial } from '@/lib/server/material-extraction/extract';
import { runNextMaterialExtraction } from '@/lib/server/material-extraction/runner';

describe('uploaded material extraction lifecycle', () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
  });

  it('uploads a source, extracts it through the registry, and reads the extracted text', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    const source = await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      title: 'notes.txt',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', source.id);
    const claim = await materials.claimNextExtraction('worker-1', { leaseTtlMs: 10_000 });
    expect(claim).not.toBeNull();

    const assets = new Map<string, Buffer>();
    const extraction = await extractClaimedSessionMaterial(claim!, {
      resolveSource: async () => ({
        bytes: Buffer.from('The uploaded lesson text.'),
        mime: 'text/plain',
      }),
      configuredProviderIds: () => [],
      putText: async (_sessionId, text) => {
        assets.set('ast_extracted', text);
        return 'ast_extracted';
      },
      complete: materials.completeExtraction.bind(materials),
    });

    const derivative = await materials.getMaterial('session-1', extraction.materialId);
    expect(derivative).toMatchObject({
      kind: 'extraction',
      derivedFrom: source.id,
      textAssetId: 'ast_extracted',
    });
    const read = buildMaterialTools({
      sessionId: 'session-1',
      getMaterial: materials.getMaterial.bind(materials),
      readTextAsset: async (_sessionId, assetId) => assets.get(assetId) ?? null,
    }).find((candidate) => candidate.name === 'read_material') as AgentTool<never, never>;
    const result = await read.execute('read', { materialId: derivative!.id } as never);
    expect((result.content[0] as { text: string }).text).toContain('The uploaded lesson text.');
    expect((await materials.getMaterial('session-1', source.id))?.extraction.status).toBe('done');
  });

  it('settles a rejected extractor as failed with its reason', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_source');

    expect(
      await runNextMaterialExtraction(materials, 'worker-1', async () => {
        throw new Error('extractor rejected input');
      }),
    ).toBe(true);
    expect((await materials.getMaterial('session-1', 'mat_source'))?.extraction).toEqual({
      status: 'failed',
      attempts: 0,
      error: 'extractor rejected input',
    });
  });

  it('requeues an extractor failure with a concrete transient signal', async () => {
    db = new PGlite();
    await db.waitReady;
    await ensureAgentSessionSchema(db);
    await ensureAgentSessionMaterialSchema(db);
    const sessions = new PgAgentSessionStore(db, {
      withTransaction: (body) => db!.transaction((tx: Queryable) => body(tx)),
    });
    const materials = new PgAgentSessionMaterialStore(db);
    await sessions.createSession({ id: 'session-1', ownerId: 'owner-1', prompt: 'p' });
    await materials.createMaterial('session-1', {
      id: 'mat_source',
      kind: 'source',
      rawAssetId: 'ast_raw',
    });
    await materials.enqueueExtraction('session-1', 'mat_source');

    await runNextMaterialExtraction(materials, 'worker-1', async () => {
      const error = new Error('connection reset') as Error & { code: string };
      error.code = 'ECONNRESET';
      throw error;
    });
    expect((await materials.getMaterial('session-1', 'mat_source'))?.extraction).toEqual({
      status: 'pending',
      attempts: 1,
      error: 'connection reset',
    });
  });
});

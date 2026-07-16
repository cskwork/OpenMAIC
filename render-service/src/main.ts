/**
 * @openmaic/render-service — HTTP entrypoint.
 *
 * Renders exported Hyperframes projects (the ZIP the app builds with
 * `packageVideoZip`) to MP4 using `@hyperframes/producer`, isolated in a
 * Node 22 + Chromium + FFmpeg container (issue #866).
 *
 * The contract is intentionally minimal and stable so the internals (in-memory
 * vs Redis job store, local-disk vs S3 artifacts) can be swapped for a
 * demo-scale deployment without the app noticing:
 *
 *   POST   /render                 multipart: project(zip) + fps/quality/format → 202 { jobId }
 *   GET    /render/:jobId          → { status, progress, currentStage, done, ... }
 *   GET    /render/:jobId/download → stream MP4 (or 302 to a presigned URL)
 *   DELETE /render/:jobId          → cancel
 *   GET    /health                 → { ok: true }
 *
 * NOTE: this file must NOT be named `server.ts`. `@hyperframes/producer`'s main
 * module auto-starts its own bundled HTTP server (on PRODUCER_PORT, default
 * 9847) as an import side effect when the process entry path ends with
 * `/src/server.ts` or `/public-server.js`. We use the producer as a library, so
 * the entrypoint is `main.ts` to avoid spawning that phantom server.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { config } from './config.js';
import { InMemoryJobStore } from './job-store.js';
import { LocalDiskArtifactStore } from './artifact-store.js';
import { RenderManager, RenderRejectedError, makeProjectDir } from './render-manager.js';
import { InvalidProjectError, unzipProject } from './unzip.js';
import { isTerminal, type RenderOptions } from './types.js';

const artifacts = new LocalDiskArtifactStore();
const jobs = new InMemoryJobStore(config.jobTtlMs, (record) => {
  // A reaped job's artifact + project dir go with it.
  void artifacts.remove(record.id);
  void manager.cleanupProject(record.projectDir);
});
const manager = new RenderManager(jobs, artifacts);

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

/** Parse + validate the multipart render options. Returns options or an error string. */
function parseOptions(form: FormData): RenderOptions | string {
  const fps = Number.parseInt(String(form.get('fps') ?? '30'), 10);
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) return 'Invalid fps';

  const quality = String(form.get('quality') ?? 'standard');
  if (quality !== 'draft' && quality !== 'standard' && quality !== 'high') {
    return 'Invalid quality (expected draft|standard|high)';
  }

  const format = String(form.get('format') ?? 'mp4');
  if (format !== 'mp4') return 'Unsupported format (only mp4)';

  return { fps, quality, format };
}

app.post('/render', async (c) => {
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: 'Expected multipart/form-data' }, 400);
  }

  const options = parseOptions(form);
  if (typeof options === 'string') return c.json({ error: options }, 400);

  const file = form.get('project');
  if (!(file instanceof File)) {
    return c.json({ error: 'Missing "project" file field' }, 400);
  }

  // Identity is derived by the trusted proxy (client IP) and passed in a header;
  // a client-supplied multipart `userId` is deliberately ignored so it can't be
  // rotated to bypass the per-identity guard.
  const identity = c.req.header('x-openmaic-client')?.trim() || 'anonymous';

  // Reserve an admission slot BEFORE extracting the archive, so a rejected
  // caller (queue full / per-identity limit) never triggers a decompression.
  let reservation;
  try {
    reservation = manager.reserve(identity);
  } catch (error) {
    if (error instanceof RenderRejectedError) return c.json({ error: error.message }, 429);
    throw error;
  }

  const projectDir = await makeProjectDir();
  try {
    await unzipProject(new Uint8Array(await file.arrayBuffer()), projectDir);
    const jobId = await manager.submit(reservation, projectDir, options);
    return c.json({ jobId }, 202);
  } catch (error) {
    manager.release(reservation);
    await manager.cleanupProject(projectDir);
    if (error instanceof InvalidProjectError) return c.json({ error: error.message }, 400);
    if (error instanceof RenderRejectedError) return c.json({ error: error.message }, 429);
    throw error;
  }
});

app.get('/render/:jobId', async (c) => {
  const job = await jobs.get(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found' }, 404);
  return c.json({
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    currentStage: job.currentStage,
    framesRendered: job.framesRendered,
    totalFrames: job.totalFrames,
    error: job.error,
    done: isTerminal(job.status),
  });
});

app.delete('/render/:jobId', async (c) => {
  const ok = await manager.cancel(c.req.param('jobId'));
  if (!ok) return c.json({ error: 'Job not found' }, 404);
  return c.json({ cancelled: true });
});

app.get('/render/:jobId/download', async (c) => {
  const jobId = c.req.param('jobId');
  const job = await jobs.get(jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);
  if (job.status !== 'succeeded') {
    return c.json({ error: `Job not ready (status: ${job.status})` }, 409);
  }

  const location = await artifacts.locate(jobId);
  if (!location) return c.json({ error: 'Artifact expired or missing' }, 404);

  // Presigned-URL stores (demo layer) redirect the browser straight to storage.
  if (location.kind === 'url') return c.redirect(location.href, 302);

  const { size } = await stat(location.path).catch(() => ({ size: 0 }));
  if (!size) return c.json({ error: 'Artifact missing on disk' }, 404);

  const webStream = Readable.toWeb(createReadStream(location.path)) as ReadableStream;
  return new Response(webStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(size),
      'Content-Disposition': `attachment; filename="${jobId}.mp4"`,
    },
  });
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `[render-service] listening on :${info.port} (maxConcurrency=${config.maxConcurrency})`,
  );
});

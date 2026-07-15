/**
 * Config — every knob the render service reads from the environment, resolved
 * once at import. Defaults suit an OSS single-host deployment; the demo layer
 * only tunes values (and, later, points the store factories at Redis/S3).
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: intEnv('PORT', 9000),
  /** Renders that execute simultaneously; extras queue FIFO. */
  maxConcurrency: intEnv('RENDER_MAX_CONCURRENCY', 2),
  /** Active (queued+running) jobs allowed per userId. 0 disables the guard. */
  maxJobsPerUser: intEnv('RENDER_MAX_JOBS_PER_USER', 1),
  /** How long a finished job's record + artifacts live before the sweeper reaps them. */
  jobTtlMs: intEnv('RENDER_JOB_TTL_MS', 30 * 60 * 1000),
  /** Root dir for unzipped projects and rendered outputs. */
  tmpDir: process.env.PRODUCER_TMP_PROJECT_DIR || '/tmp/openmaic-renders',
} as const;

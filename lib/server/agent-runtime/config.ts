/** Server-only agent runtime configuration. */
const numberFromEnv = (value: string | undefined, fallback: number) =>
  value ? Number(value) : fallback;

export const agentRuntimeConfig = {
  /** How often the runner scans for claimable sessions. */
  scanIntervalMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_SCAN_INTERVAL_MS, 1000),
  /** How often a running session's lease heartbeat is refreshed. */
  heartbeatIntervalMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_HEARTBEAT_MS, 2000),
  /**
   * A running session with an older heartbeat is orphaned and may be resumed
   * elsewhere. Keep this comfortably above the heartbeat interval so a slow
   * heartbeat is not mistaken for a dead worker.
   */
  leaseTtlMs: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_LEASE_TTL_MS, 10_000),
  /** Maximum sessions one application instance runs concurrently. */
  maxConcurrent: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_MAX_CONCURRENT, 2),
  /** Maximum consecutive unattended starts or resumptions. */
  maxAttempts: numberFromEnv(process.env.OPENMAIC_AGENT_RUNTIME_MAX_ATTEMPTS, 5),
  /**
   * Native conversation compaction is opt-in at this layer: it runs only when
   * OPENMAIC_AGENT_COMPACTION_ENABLED=true. This is a deliberate inversion of
   * the reference runtime's opt-out default — the reusable compaction runtime
   * lands in a later slice, and until then the runner runs without context
   * transformation.
   */
  compaction: {
    enabled: process.env.OPENMAIC_AGENT_COMPACTION_ENABLED === 'true',
    ...(process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS
      ? {
          reserveTokens: numberFromEnv(process.env.OPENMAIC_AGENT_COMPACTION_RESERVE_TOKENS, 0),
        }
      : {}),
    ...(process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS
      ? {
          keepRecentTokens: numberFromEnv(
            process.env.OPENMAIC_AGENT_COMPACTION_KEEP_RECENT_TOKENS,
            0,
          ),
        }
      : {}),
  },
} as const;

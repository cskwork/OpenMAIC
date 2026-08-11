import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

const GIB = 1024 ** 3;

export type ResourceProfileName = 'standard' | 'low-memory';
export type RequestedCaptureMode = 'beginframe' | 'screenshot';

export interface ResourceProfile {
  name: ResourceProfileName;
  requestedCaptureMode: RequestedCaptureMode;
  requireBeginFrame: boolean;
  producerWorkers: 1;
  maxConcurrency: 1;
  maxConcurrentExtractions: 1;
  minimumMemoryBytes: number;
  producerEnvironment: Readonly<Record<string, string>>;
}

const PROFILES: Record<ResourceProfileName, ResourceProfile> = {
  standard: {
    name: 'standard',
    requestedCaptureMode: 'beginframe',
    requireBeginFrame: true,
    producerWorkers: 1,
    maxConcurrency: 1,
    maxConcurrentExtractions: 1,
    minimumMemoryBytes: 10 * GIB,
    producerEnvironment: {
      PRODUCER_MAX_WORKERS: '1',
      PRODUCER_LOW_MEMORY_MODE: 'false',
      PRODUCER_FORCE_SCREENSHOT: 'false',
      // The producer's software selector uses SwiftShader and keeps BeginFrame
      // eligible with no host GPU or device passthrough.
      PRODUCER_BROWSER_GPU_MODE: 'software',
      PRODUCER_ENABLE_BROWSER_POOL: 'false',
      PRODUCER_EXPECTED_CHROMIUM_MAJOR: '151',
      RENDER_REQUIRE_BEGINFRAME: 'true',
    },
  },
  'low-memory': {
    name: 'low-memory',
    requestedCaptureMode: 'screenshot',
    requireBeginFrame: false,
    producerWorkers: 1,
    maxConcurrency: 1,
    maxConcurrentExtractions: 1,
    minimumMemoryBytes: 4 * GIB,
    producerEnvironment: {
      PRODUCER_MAX_WORKERS: '1',
      PRODUCER_LOW_MEMORY_MODE: 'true',
      PRODUCER_FORCE_SCREENSHOT: 'true',
      PRODUCER_BROWSER_GPU_MODE: 'software',
      PRODUCER_ENABLE_BROWSER_POOL: 'false',
      PRODUCER_EXPECTED_CHROMIUM_MAJOR: '151',
      RENDER_REQUIRE_BEGINFRAME: 'false',
    },
  },
};

function assertCompatibleEnvironment(profile: ResourceProfile, env: NodeJS.ProcessEnv): void {
  for (const [name, required] of Object.entries(profile.producerEnvironment)) {
    const configured = env[name];
    if (configured !== undefined && configured !== required) {
      throw new Error(
        `RENDER_RESOURCE_PROFILE=${profile.name} requires ${name}=${required}; ` +
          `received ${configured}. Select a different resource profile instead of overriding it.`,
      );
    }
    env[name] = required;
  }

  const serviceLimits = {
    RENDER_MAX_CONCURRENCY: String(profile.maxConcurrency),
    RENDER_MAX_CONCURRENT_EXTRACTIONS: String(profile.maxConcurrentExtractions),
  };
  for (const [name, required] of Object.entries(serviceLimits)) {
    const configured = env[name];
    if (configured !== undefined && configured !== required) {
      throw new Error(
        `RENDER_RESOURCE_PROFILE=${profile.name} requires ${name}=${required}; ` +
          `received ${configured}.`,
      );
    }
  }
}

export function resolveResourceProfile(env: NodeJS.ProcessEnv = process.env): ResourceProfile {
  const raw = env.RENDER_RESOURCE_PROFILE?.trim() || 'standard';
  if (raw !== 'standard' && raw !== 'low-memory') {
    throw new Error(`Invalid RENDER_RESOURCE_PROFILE=${raw}; expected standard or low-memory.`);
  }
  const profile = PROFILES[raw];
  assertCompatibleEnvironment(profile, env);
  return profile;
}

function finiteMemoryLimit(path: string): number | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw || raw === 'max') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Effective host/cgroup memory available to this process. */
export function availableMemoryBytes(): number {
  const limits = [
    totalmem(),
    finiteMemoryLimit('/sys/fs/cgroup/memory.max'),
    finiteMemoryLimit('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
  ].filter((value): value is number => value !== undefined);
  return Math.min(...limits);
}

export function validateResourceProfileStartup(
  profile: ResourceProfile,
  options: {
    memoryBytes?: number;
    headlessShellPath?: string;
    pathExists?: (path: string) => boolean;
  } = {},
): void {
  const memoryBytes = options.memoryBytes ?? availableMemoryBytes();
  if (memoryBytes < profile.minimumMemoryBytes) {
    const actualGiB = (memoryBytes / GIB).toFixed(1);
    const minimumGiB = profile.minimumMemoryBytes / GIB;
    throw new Error(
      `Render resource profile ${profile.name} requires at least ${minimumGiB} GiB memory; ` +
        `detected ${actualGiB} GiB.`,
    );
  }

  if (profile.requireBeginFrame) {
    const headlessShellPath = options.headlessShellPath ?? process.env.PRODUCER_HEADLESS_SHELL_PATH;
    const pathExists = options.pathExists ?? existsSync;
    if (!headlessShellPath || !pathExists(headlessShellPath)) {
      throw new Error(
        `Render resource profile ${profile.name} requires an existing ` +
          'PRODUCER_HEADLESS_SHELL_PATH for BeginFrame capture.',
      );
    }
  }
}

export function publicResourceProfile(profile: ResourceProfile) {
  return {
    name: profile.name,
    requestedCaptureMode: profile.requestedCaptureMode,
    requireBeginFrame: profile.requireBeginFrame,
    producerWorkers: profile.producerWorkers,
    maxConcurrency: profile.maxConcurrency,
    maxConcurrentExtractions: profile.maxConcurrentExtractions,
    minimumMemoryMiB: profile.minimumMemoryBytes / 1024 ** 2,
  } as const;
}

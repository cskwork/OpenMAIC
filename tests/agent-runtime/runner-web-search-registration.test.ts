/**
 * Runner-level pins for capability-registered `web_search` wiring.
 *
 * The tool-level tests in web-search.test.ts exercise the tool itself. This
 * file drives the actual `runSession` loop through a fake agent (mocked
 * `buildAgent`) so the RUNNER WIRING is observable: the toolset the agent
 * receives, the allowlist it is given, and the system prompt it is built with
 * all depend on whether a web-search backend is configured:
 *
 * - configured: both ask_user and web_search are registered and the prompt
 *   carries the web-search capability block (and no ask_user-only claim);
 * - unconfigured: the toolset is ask_user-only, the allowlist matches, and the
 *   prompt never mentions web_search — the model never sees a dead tool.
 */
import type { AgentEvent, AgentMessage } from '@earendil-works/pi-agent-core';
import { InMemorySessionRepo, Session } from '@earendil-works/pi-agent-core';
import type { ClaimedAgentSession } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  randomUUID: vi.fn(() => 'runner-test-uuid'),
  getAgentSessionStore: vi.fn(),
  openEntryStorage: vi.fn(),
  resolveAgentDriverModel: vi.fn(),
  createCallLlmStreamFn: vi.fn(),
  buildAgent: vi.fn(),
  resolveWebSearchCapability: vi.fn(),
}));

vi.mock('node:crypto', async (importActual) => {
  const actual = await importActual<typeof import('node:crypto')>();
  return { ...actual, randomUUID: mocks.randomUUID };
});

vi.mock('@/lib/server/agent-runtime/store', () => ({
  getAgentSessionStore: mocks.getAgentSessionStore,
}));

vi.mock('@/lib/server/agent-runtime/entry-tree-storage', async (importActual) => {
  const actual =
    await importActual<typeof import('@/lib/server/agent-runtime/entry-tree-storage')>();
  return {
    ...actual,
    AgentSessionEntryStorage: {
      open: mocks.openEntryStorage,
    },
  };
});

vi.mock('@/lib/server/agent-runtime/agent-driver-model', () => ({
  resolveAgentDriverModel: mocks.resolveAgentDriverModel,
}));

vi.mock('@/lib/agent/runtime/stream-fn', () => ({
  createCallLlmStreamFn: mocks.createCallLlmStreamFn,
}));

vi.mock('@/lib/agent/runtime/build-agent', () => ({
  buildAgent: mocks.buildAgent,
}));

// Keep the real tool builder and prompt block; only the capability resolution
// is faked, so the assertions observe the actual registered tool and prompt.
vi.mock('@/lib/server/agent-runtime/web-search', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/server/agent-runtime/web-search')>();
  return {
    ...actual,
    resolveWebSearchCapability: mocks.resolveWebSearchCapability,
  };
});

import { runSession } from '@/lib/server/agent-runtime/runner';

const SESSION_ID = 'session-1';
/** Mirrors the runner's `WORKER_ID` derivation with the fixed mock uuid. */
const WORKER_ID = `runner-t:${process.pid}`;

function makeMeta(overrides: Partial<ClaimedAgentSession> = {}): ClaimedAgentSession {
  return {
    id: SESSION_ID,
    ownerId: 'owner-1',
    prompt: 'Help me',
    stageId: 'stage-1',
    existingCourse: false,
    status: 'running',
    attempt: 1,
    createdAt: 1,
    updatedAt: 1,
    claimReason: 'queued',
    claimSeq: 0,
    ...overrides,
  };
}

function makeStore(meta: ClaimedAgentSession) {
  let seq = 0;
  return {
    appendRunEvent: vi.fn(
      async (
        _id: string,
        _workerId: string,
        _event: { type: string; data?: Record<string, unknown> },
      ) => {
        seq += 1;
        return seq;
      },
    ),
    clearCancel: vi.fn(async () => undefined),
    finishSession: vi.fn(async () => true),
    getSession: vi.fn(async () => ({ ...meta, lease: { workerId: WORKER_ID } })),
    hasSessionRunHistory: vi.fn(async () => false),
    heartbeat: vi.fn(async () => true),
    isCancelRequested: vi.fn(async () => false),
    listUserMessages: vi.fn(async () => []),
    releaseLease: vi.fn(async () => undefined),
    requeueForRetry: vi.fn(async () => false),
    requeueSession: vi.fn(async () => false),
  };
}

async function makeEntryTree(): Promise<Session> {
  const repo = new InMemorySessionRepo();
  return repo.create({ id: SESSION_ID });
}

interface FakeAgent {
  subscribe(listener: (event: AgentEvent, signal?: AbortSignal) => void): () => void;
  prompt(text: string): Promise<void>;
  continue(): Promise<void>;
  waitForIdle(): Promise<void>;
  steer(message: AgentMessage): void;
  abort(): void;
  readonly state: { messages: AgentMessage[]; errorMessage?: string };
}

function makeFakeAgent(): FakeAgent {
  const messages: AgentMessage[] = [];
  const listeners = new Set<(event: AgentEvent, signal?: AbortSignal) => void>();
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prompt: async () => {},
    continue: async () => {},
    waitForIdle: async () => {},
    steer: () => {},
    abort: () => {},
    state: {
      get messages() {
        return messages;
      },
      errorMessage: undefined,
    },
  };
}

interface BuildAgentOptions {
  systemPrompt: string;
  tools: Array<{ name: string }>;
  allowedToolNames?: ReadonlySet<string>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgentDriverModel.mockResolvedValue({
    connection: { model: undefined, thinkingConfig: undefined },
    piModel: undefined,
    wireMaxOutputTokens: undefined,
    reservedOutputTokens: 8192,
  });
  mocks.createCallLlmStreamFn.mockReturnValue((() => {}) as never);
  mocks.buildAgent.mockReturnValue(makeFakeAgent() as never);
});

async function runToBuildAgent(): Promise<BuildAgentOptions> {
  const meta = makeMeta();
  const session = await makeEntryTree();
  const store = makeStore(meta);
  mocks.openEntryStorage.mockResolvedValue(session.getStorage());
  mocks.getAgentSessionStore.mockResolvedValue(store);

  let options: BuildAgentOptions | undefined;
  mocks.buildAgent.mockImplementation((agentOptions: BuildAgentOptions) => {
    options = agentOptions;
    return makeFakeAgent();
  });

  await runSession({ running: new Map(), shuttingDown: false }, meta);

  expect(options, 'buildAgent must be called with the run options').toBeDefined();
  expect(store.finishSession).toHaveBeenCalledWith(
    SESSION_ID,
    WORKER_ID,
    expect.objectContaining({ status: 'succeeded' }),
  );
  return options!;
}

describe('web_search runner registration', () => {
  it('registers both tools and the web-search prompt block when a backend is configured', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue({
      providerId: 'searxng',
      apiKey: '',
      baseUrl: 'https://search.example',
    });

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual(['ask_user', 'web_search']);
    expect([...(options.allowedToolNames ?? [])].sort()).toEqual(['ask_user', 'web_search']);
    expect(options.systemPrompt).toContain('## Web search');
    expect(options.systemPrompt).toContain('web_search');
    // The capability is registered: the ask_user-only claim would be false.
    expect(options.systemPrompt).not.toContain('Your only available tool is ask_user');
  });

  it('registers ask_user only and no web-search prompt when nothing is configured', async () => {
    mocks.resolveWebSearchCapability.mockReturnValue(null);

    const options = await runToBuildAgent();

    expect(options.tools.map((tool) => tool.name)).toEqual(['ask_user']);
    expect([...(options.allowedToolNames ?? [])]).toEqual(['ask_user']);
    expect(options.systemPrompt).not.toContain('web_search');
    expect(options.systemPrompt).not.toContain('## Web search');
    // In this state the ask_user-only claim is accurate and stays in place.
    expect(options.systemPrompt).toContain('Your only available tool is ask_user');
  });
});

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpRuntimeStore, HttpRuntimeStoreError } from '../src/runtime/http.js';
import { runRuntimeStoreContract } from './runtime-contract.js';
import {
  startHttpConformanceServer,
  type HttpConformanceServer,
} from './http-conformance-server.js';

const T0 = '2026-01-01T00:00:00.000Z';
let server: HttpConformanceServer;
let namespace = 0;

beforeAll(async () => {
  server = await startHttpConformanceServer({ listen: false });
});

afterAll(async () => {
  await server.close();
});

runRuntimeStoreContract('HTTP', () => {
  const storeId = `contract-${namespace++}`;
  return new HttpRuntimeStore({
    baseUrl: server.baseUrl,
    fetch: server.fetch,
    headers: () => ({ 'x-runtime-store-id': storeId }),
  });
});

describe('HttpRuntimeStore error mapping', () => {
  test('reconstitutes a 400 validation failure as an Error with its code and message', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': `errors-${namespace++}` }),
    });

    const failure = store.createSession({
      id: 'invalid',
      kind: 'chat',
      stageId: 'stage-1',
      learnerKey: '',
      status: 'active',
      createdAt: T0,
      updatedAt: T0,
    });

    await expect(failure).rejects.toMatchObject({
      name: 'HttpRuntimeStoreError',
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    await expect(failure).rejects.toThrow(/learnerKey/);
  });

  test('reconstitutes a 404 missing-session response with browser-store semantics', async () => {
    const store = new HttpRuntimeStore({
      baseUrl: server.baseUrl,
      fetch: server.fetch,
      headers: () => ({ 'x-runtime-store-id': `errors-${namespace++}` }),
    });

    const failure = store.setSessionStatus('ghost', 'completed', T0);
    await expect(failure).rejects.toMatchObject({
      name: 'HttpRuntimeStoreError',
      status: 404,
      code: 'SESSION_NOT_FOUND',
    });
    await expect(failure).rejects.toThrow(/no session/i);
  });

  test('reconstitutes a 409 future-version response with fail-loud semantics', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'FUTURE_VERSION',
            message:
              '@openmaic/storage: session "future" was written at runtime DSL version "99.0.0", newer than this client\'s 1.0.0',
          },
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      );
    const store = new HttpRuntimeStore({ baseUrl: 'https://runtime.invalid', fetch });

    const failure = store.setSessionStatus('future', 'completed', T0);
    await expect(failure).rejects.toBeInstanceOf(HttpRuntimeStoreError);
    await expect(failure).rejects.toMatchObject({ status: 409, code: 'FUTURE_VERSION' });
    await expect(failure).rejects.toThrow(/newer than this client's/);
  });
});

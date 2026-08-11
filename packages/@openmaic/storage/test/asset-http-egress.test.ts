// The opt-in indirect byte egress of the asset contract, driven against a
// stub AssetStore over a real loopback server: redirect off by default, the
// 302 shape when opted in, the fallbacks when the byte layer cannot sign, and
// the rule that authorization runs before any URL is minted.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { AssetId } from '../src/asset/id.js';
import type { AssetIndirectReadRequest, AssetPrincipal, AssetStore } from '../src/asset/types.js';
import { createAssetHttpHandler, type AssetHttpHandlerOptions } from '../src/server/asset.js';

const PRINCIPAL: AssetPrincipal = { key: 'principal-a' };
const BYTES = new Uint8Array([1, 2, 3, 4]);

interface StubStoreOptions {
  mime?: string;
  revision?: number;
  indirect?: (
    principal: AssetPrincipal,
    ref: string,
    request: AssetIndirectReadRequest,
  ) => Promise<{ url: string; revision: number } | null | undefined>;
}

function stubStore(options: StubStoreOptions = {}): AssetStore {
  const mime = options.mime ?? 'image/png';
  const revision = options.revision ?? 3;
  const store: AssetStore = {
    put: async () => 'ast_stub' as AssetId,
    identify: async () => ({ mime, revision, byteLength: BYTES.byteLength }),
    resolve: async () => ({ bytes: new Uint8Array(BYTES), mime, revision }),
    remove: async () => undefined,
    replace: async () => revision + 1,
  };
  if (options.indirect !== undefined) {
    store.resolveIndirect = vi.fn(options.indirect);
  }
  return store;
}

interface RunningServer {
  url: string;
  close(): Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(
  store: AssetStore,
  options: Partial<AssetHttpHandlerOptions> = {},
): Promise<RunningServer> {
  const handler = createAssetHttpHandler(store, {
    authenticate: async () => PRINCIPAL,
    ...options,
  });
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `manual`, so the test sees the 302 itself rather than the redirected response. */
function getBytes(url: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
  return fetch(`${url}/assets/ast_example/content`, { method, redirect: 'manual' });
}

describe('asset byte egress', () => {
  test('serves bytes directly by default, even when the store can sign', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }));

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(indirect).not.toHaveBeenCalled();
  });

  test('answers 302 with a signed Location when opted in and the store can sign', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const { url } = await serve(stubStore({ indirect }), { byteEgress: 'redirect' });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://objects.example/signed');
    // The redirect repeats the read route's posture: revision, no-store, and
    // the credential variance, with no body.
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(await response.text()).toBe('');
  });

  test('mints the URL under the same authorization and labelling as a direct read', async () => {
    let seen:
      | { principal: AssetPrincipal; ref: string; request: AssetIndirectReadRequest }
      | undefined;
    const indirect = vi.fn(
      async (principal: AssetPrincipal, ref: string, request: AssetIndirectReadRequest) => {
        seen = { principal, ref, request };
        return { url: 'https://objects.example/signed', revision: 7 };
      },
    );
    const { url } = await serve(stubStore({ indirect }), { byteEgress: 'redirect' });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(indirect).toHaveBeenCalledOnce();
    expect(seen?.principal).toEqual(PRINCIPAL);
    expect(seen?.ref).toBe('ast_example');
    // The label reproduces the direct response's allowlist outcome, so the
    // signature pins what the direct path would have served.
    expect(seen?.request.cacheControl).toBe('private, no-store');
    expect(seen?.request.expiresInSeconds).toBe(60);
    expect(seen?.request.label('image/png')).toEqual({ contentType: 'image/png' });
    expect(seen?.request.label('text/plain')).toEqual({
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
    });
    expect(seen?.request.label('IMAGE/PNG')).toEqual({ contentType: 'image/png' });
  });

  test('passes a configured signed URL lifetime through to the store', async () => {
    let ttl = 0;
    const indirect = vi.fn(
      async (_principal: AssetPrincipal, _ref: string, request: AssetIndirectReadRequest) => {
        ttl = request.expiresInSeconds;
        return { url: 'https://objects.example/signed', revision: 3 };
      },
    );
    const { url } = await serve(stubStore({ indirect }), {
      byteEgress: 'redirect',
      signedUrlTtlSeconds: 5,
    });

    const response = await getBytes(url);

    expect(response.status).toBe(302);
    expect(ttl).toBe(5);
  });

  test('falls back to direct bytes when the store declines to sign', async () => {
    const indirect = vi.fn(async () => undefined);
    const { url } = await serve(stubStore({ indirect }), { byteEgress: 'redirect' });

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
    expect(indirect).toHaveBeenCalledOnce();
  });

  test('falls back to direct bytes when the store has no indirect resolution', async () => {
    const { url } = await serve(stubStore(), { byteEgress: 'redirect' });

    const response = await getBytes(url);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BYTES);
  });

  test('a miss under indirect egress is the same 404 as a direct miss', async () => {
    const indirect = vi.fn(async () => null);
    const { url } = await serve(stubStore({ indirect }), { byteEgress: 'redirect' });

    const response = await getBytes(url);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-error-code')).toBe('ASSET_NOT_FOUND');
  });

  test('authorization runs before any URL is minted', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const denied = await serve(stubStore({ indirect }), {
      byteEgress: 'redirect',
      authorizeAssets: async () => false,
    });

    const deniedResponse = await getBytes(denied.url);

    expect(deniedResponse.status).toBe(403);
    expect(deniedResponse.headers.get('x-error-code')).toBe('FORBIDDEN_ASSETS');
    expect(indirect).not.toHaveBeenCalled();

    const unauthenticated = await serve(stubStore({ indirect }), {
      byteEgress: 'redirect',
      authenticate: async () => undefined,
    });

    const unauthenticatedResponse = await getBytes(unauthenticated.url);

    expect(unauthenticatedResponse.status).toBe(401);
    expect(indirect).not.toHaveBeenCalled();
  });

  test('HEAD never redirects, so revision revalidation stays direct', async () => {
    const indirect = vi.fn(async () => ({ url: 'https://objects.example/signed', revision: 3 }));
    const store = stubStore({ indirect });
    const resolve = vi.spyOn(store, 'resolve');
    const { url } = await serve(store, { byteEgress: 'redirect' });

    const response = await getBytes(url, 'HEAD');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-asset-revision')).toBe('3');
    expect(response.headers.get('content-length')).toBe(String(BYTES.byteLength));
    expect(indirect).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  test('a signed URL lifetime requires the redirect egress it configures', () => {
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        signedUrlTtlSeconds: 5,
      }),
    ).toThrow(/signedUrlTtlSeconds requires byteEgress "redirect"/);
  });

  test('a malformed egress mode is rejected at construction', () => {
    expect(() =>
      createAssetHttpHandler(stubStore(), {
        authenticate: async () => PRINCIPAL,
        byteEgress: 'proxy' as never,
      }),
    ).toThrow(/byteEgress must be "direct" or "redirect"/);
  });
});

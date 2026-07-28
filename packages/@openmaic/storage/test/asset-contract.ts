// Implementation-agnostic contract for a `StorageProvider` (the DSL-owned asset
// seam). `resolve` yields a URL whose *bytes* must equal what was `put`; how a
// URL is read back differs per backend (object URL vs HTTP), so the reader is
// injected, keeping the assertions universal across backends.
import { describe, expect, test } from 'vitest';
import type { StorageProvider } from '@openmaic/dsl';

type ReadUrl = (url: string) => Promise<Uint8Array>;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
// Build the Blob from the string directly (a string is a valid BlobPart). A
// `Uint8Array` BlobPart trips TS 5.7+'s `Uint8Array<ArrayBufferLike>` vs
// `ArrayBufferView<ArrayBuffer>` narrowing under the root tsconfig; the bytes
// are UTF-8 either way, so `bytes(s)` stays the source of truth for comparison.
const blob = (s: string, type = 'text/plain'): Blob => new Blob([s], { type });

export function runStorageProviderContract(
  name: string,
  makeProvider: () => StorageProvider,
  readUrl: ReadUrl,
): void {
  describe(`StorageProvider contract: ${name}`, () => {
    test('put returns a non-empty ref', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('hello'));
      expect(typeof ref).toBe('string');
      expect(ref.length).toBeGreaterThan(0);
    });

    test('is content-addressed: identical bytes yield the same ref', async () => {
      const p = makeProvider();
      const a = await p.put(blob('same-content'));
      const b = await p.put(blob('same-content'));
      expect(a).toBe(b);
    });

    test('distinct bytes yield distinct refs', async () => {
      const p = makeProvider();
      const a = await p.put(blob('one'));
      const b = await p.put(blob('two'));
      expect(a).not.toBe(b);
    });

    test('resolve yields a URL whose bytes equal the stored blob', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('round-trip me'));
      const url = await p.resolve(ref);
      expect(url).not.toBeNull();
      expect(await readUrl(url!)).toEqual(bytes('round-trip me'));
    });

    test('concurrent resolve of the same ref yields one shared URL', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('shared'));
      // Two in-flight resolves must not each mint a URL (the second would orphan
      // the first, which only `remove` could ever revoke). They share one.
      const [a, b] = await Promise.all([p.resolve(ref), p.resolve(ref)]);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    test('resolve returns null for an unknown ref', async () => {
      const p = makeProvider();
      expect(await p.resolve('sha256-deadbeef')).toBeNull();
    });

    // The ref domain belongs to the primitive, not to one backend: a ref that
    // one backend addresses and another cannot is not a portable handle, and a
    // decoded ref must never be able to introduce a path segment for whatever
    // storage sits underneath.
    test.each([
      ['an empty ref', '', /must not be empty/],
      ['a ref containing "/"', 'a/b', /must not contain/],
      ['a ref containing "\\"', 'a\\b', /must not contain/],
      ['a traversal-shaped ref', '../../etc/passwd', /must not contain/],
      ['the dot segment "."', '.', /URL path segment/],
      ['the dot segment ".."', '..', /URL path segment/],
      ['a ref containing NUL', 'bad\u0000ref', /NUL/],
      ['a ref containing an unpaired surrogate', '\uD800', /surrogate/],
      ['an over-long ref', 'r'.repeat(513), /exceeds 512 UTF-8 bytes/],
    ])('refuses %s', async (_name, ref, message) => {
      const p = makeProvider();
      await expect(p.resolve(ref)).rejects.toThrow(message);
      await expect(p.remove(ref)).rejects.toThrow(message);
    });

    // Zero bytes is a legal asset. It hashes like anything else, so every empty
    // asset in a deployment collapses to one well-known ref by design.
    test('stores and resolves a zero-byte asset', async () => {
      const p = makeProvider();
      const ref = await p.put(new Blob([], { type: 'text/plain' }));
      expect(ref).toBe('sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

      const url = await p.resolve(ref);
      expect(url).not.toBeNull();
      expect(await readUrl(url!)).toEqual(new Uint8Array());
    });

    test('resolve returns null after remove', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('temporary'));
      await p.remove(ref);
      expect(await p.resolve(ref)).toBeNull();
    });
  });
}

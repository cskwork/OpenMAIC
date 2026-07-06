// Implementation-agnostic contract for a `StorageProvider` (the DSL-owned asset
// seam). `resolve` yields a URL whose *bytes* must equal what was `put`; how a
// URL is read back differs per backend (object URL vs HTTP), so the reader is
// injected, keeping the assertions universal across backends.
import { describe, expect, test } from 'vitest';
import type { StorageProvider } from '@openmaic/dsl';

type ReadUrl = (url: string) => Promise<Uint8Array>;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const blob = (s: string, type = 'text/plain'): Blob => new Blob([bytes(s)], { type });

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

    test('resolve returns null for an unknown ref', async () => {
      const p = makeProvider();
      expect(await p.resolve('sha256-deadbeef')).toBeNull();
    });

    test('resolve returns null after remove', async () => {
      const p = makeProvider();
      const ref = await p.put(blob('temporary'));
      await p.remove(ref);
      expect(await p.resolve(ref)).toBeNull();
    });
  });
}

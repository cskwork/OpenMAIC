// Implementation-agnostic contract for the OUTWARD asset store (the DSL-owned
// `StorageProvider` seam), whose refs are *allocated* ids over a
// content-addressed blob layer. `resolve` yields a URL whose bytes must equal
// what was `put`; how a URL is read back differs per backend (object URL vs
// HTTP), so the reader is injected, keeping the assertions universal.
//
// The content-addressed semantics of the blob layer underneath live in
// `asset-blob-contract.ts` and are deliberately the opposite of these: down
// there identical bytes share a key, up here they never share an id.
import { describe, expect, test } from 'vitest';
import type { AssetMeta, AssetRef, StorageProvider } from '@openmaic/dsl';

type ReadUrl = (url: string) => Promise<Uint8Array>;

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
// Build the Blob from the string directly (a string is a valid BlobPart). A
// `Uint8Array` BlobPart trips TS 5.7+'s `Uint8Array<ArrayBufferLike>` vs
// `ArrayBufferView<ArrayBuffer>` narrowing under the root tsconfig; the bytes
// are UTF-8 either way, so `bytes(s)` stays the source of truth for comparison.
const blob = (s: string, type = 'text/plain'): Blob => new Blob([s], { type });

/**
 * Ids a caller might hand back that the store never issued. Every one must be
 * an ordinary miss — the id domain is opaque and unvalidated, so there is no
 * such thing as a malformed id, only an id nothing is stored under.
 */
const FOREIGN_IDS: ReadonlyArray<readonly [label: string, id: string]> = [
  ['empty string', ''],
  ['whitespace', '   '],
  ['bare prefix', 'ast_'],
  ['4 KiB of padding', `ast_${'x'.repeat(4096)}`],
  ['bucket/path shape', 'bucket/path/to/object.png'],
  ['legacy content-addressed ref', 'sha256-deadbeefdeadbeefdeadbeefdeadbeef'],
  ['embedded NUL', 'ast_before\u0000after'],
  ['path traversal shape', '../../etc/passwd'],
  ['non-ASCII', 'ast_\u00e9-\u4e2d-\ud83d\ude00'],
  ['newline', 'ast_a\nb'],
];

/**
 * Everything a caller can observe about one `put` and the id it returns. The
 * existence-disclosure matrix compares two of these — one whose bytes were
 * already in the pool, one whose bytes were new — facet by facet.
 */
interface PutObservation {
  putOutcome: string;
  idType: string;
  idPrefix: string;
  idLength: number;
  idCollidesWithEarlierId: boolean;
  resolvesToUrl: boolean;
  resolvedBytesMatch: boolean;
  removeOutcome: string;
  resolvesAfterRemove: boolean;
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return `threw:${err instanceof Error ? err.name : typeof err}`;
  }
}

export function runAssetStoreContract(
  name: string,
  makeStore: () => StorageProvider,
  readUrl: ReadUrl,
): void {
  const putAll = (store: StorageProvider, content: string, times: number): Promise<AssetRef[]> =>
    Promise.all(Array.from({ length: times }, () => store.put(blob(content))));

  /** Resolve a ref and read the bytes back, or `null` when it is a miss. */
  const bytesAt = async (store: StorageProvider, ref: AssetRef): Promise<Uint8Array | null> => {
    const url = await store.resolve(ref);
    return url === null ? null : readUrl(url);
  };

  async function observePut(
    store: StorageProvider,
    content: string,
    seen: Set<string>,
  ): Promise<PutObservation> {
    let id: AssetRef | undefined;
    const putOutcome = await outcome(async () => {
      id = await store.put(blob(content));
    });
    const ref = id ?? '';
    const resolved = await bytesAt(store, ref);
    const observation: PutObservation = {
      putOutcome,
      idType: typeof id,
      idPrefix: ref.slice(0, 4),
      idLength: ref.length,
      idCollidesWithEarlierId: seen.has(ref),
      resolvesToUrl: resolved !== null,
      resolvedBytesMatch: resolved !== null && new TextDecoder().decode(resolved) === content,
      removeOutcome: await outcome(() => store.remove(ref)),
      resolvesAfterRemove: (await store.resolve(ref)) !== null,
    };
    seen.add(ref);
    return observation;
  }

  describe(`asset store contract: ${name}`, () => {
    test('put returns a non-empty id', async () => {
      const s = makeStore();
      const id = await s.put(blob('hello'));
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    test('ids are allocated: identical bytes yield distinct ids', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'same-content', 2);
      expect(a).not.toBe(b);
    });

    test('every put allocates: N puts of identical bytes yield N distinct ids', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'repeat me', 5);
      expect(new Set(ids).size).toBe(5);
    });

    test('distinct bytes yield distinct ids', async () => {
      const s = makeStore();
      const a = await s.put(blob('one'));
      const b = await s.put(blob('two'));
      expect(a).not.toBe(b);
    });

    test('each id of the same bytes resolves to those bytes', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'shared bytes', 2);
      expect(await bytesAt(s, a)).toEqual(bytes('shared bytes'));
      expect(await bytesAt(s, b)).toEqual(bytes('shared bytes'));
    });

    test('resolve yields a URL whose bytes equal the stored blob', async () => {
      const s = makeStore();
      const id = await s.put(blob('round-trip me'));
      const url = await s.resolve(id);
      expect(url).not.toBeNull();
      expect(await readUrl(url!)).toEqual(bytes('round-trip me'));
    });

    test('concurrent resolve of the same id yields one shared URL', async () => {
      const s = makeStore();
      const id = await s.put(blob('shared'));
      // Two in-flight resolves must not each mint a URL (the second would orphan
      // the first, which only `remove` could ever revoke). They share one.
      const [a, b] = await Promise.all([s.resolve(id), s.resolve(id)]);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    });

    test('concurrent puts of identical bytes allocate distinct, resolvable ids', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'racing bytes', 8);
      expect(new Set(ids).size).toBe(8);
      for (const id of ids) expect(await bytesAt(s, id)).toEqual(bytes('racing bytes'));
    });

    // The one bypass this design has to close explicitly: `put`-ing bytes that
    // already exist must not tell the caller so, or `put` becomes an existence
    // oracle over data the caller never stored. Compared facet by facet rather
    // than asserted in prose — a newly discovered observable facet has to be
    // added to `PutObservation` to count as covered.
    test('put discloses nothing about whether the bytes already existed', async () => {
      const s = makeStore();
      const seen = new Set<string>();
      // Seed so the next put of these bytes is a de-duplication hit...
      seen.add(await s.put(blob('pre-existing bytes')));
      const dedupeHit = await observePut(s, 'pre-existing bytes', seen);
      // ...compared against a put of bytes the store has never seen, at the
      // same call ordinal on the same store instance.
      const firstStore = await observePut(s, 'brand new bytes', seen);
      expect(dedupeHit).toEqual(firstStore);
      // Pin the expected values too, so two identically *broken* observations
      // could not agree their way to a pass.
      expect(dedupeHit).toMatchObject({
        putOutcome: 'ok',
        idType: 'string',
        idCollidesWithEarlierId: false,
        resolvesToUrl: true,
        resolvedBytesMatch: true,
        removeOutcome: 'ok',
        resolvesAfterRemove: false,
      });
    });

    test('removing one id leaves the other ids of the same bytes resolvable', async () => {
      const s = makeStore();
      const [a, b] = await putAll(s, 'two owners', 2);
      await s.remove(a);
      expect(await s.resolve(a)).toBeNull();
      expect(await bytesAt(s, b)).toEqual(bytes('two owners'));
    });

    test('removing every id of some bytes leaves them unresolvable', async () => {
      const s = makeStore();
      const ids = await putAll(s, 'last reference', 3);
      for (const id of ids) await s.remove(id);
      for (const id of ids) expect(await s.resolve(id)).toBeNull();
    });

    test('remove is idempotent', async () => {
      const s = makeStore();
      const id = await s.put(blob('temporary'));
      await expect(s.remove(id)).resolves.toBeUndefined();
      await expect(s.remove(id)).resolves.toBeUndefined();
      expect(await s.resolve(id)).toBeNull();
    });

    test('removing one asset leaves an unrelated asset untouched', async () => {
      const s = makeStore();
      const a = await s.put(blob('doomed'));
      const b = await s.put(blob('bystander'));
      await s.remove(a);
      expect(await bytesAt(s, b)).toEqual(bytes('bystander'));
    });

    test('resolve returns null after remove', async () => {
      const s = makeStore();
      const id = await s.put(blob('temporary'));
      await s.remove(id);
      expect(await s.resolve(id)).toBeNull();
    });

    // The id domain is opaque and unvalidated: an id the store never issued is
    // a miss, never an error, whatever it looks like.
    describe('unknown ids are misses, not errors', () => {
      for (const [label, id] of FOREIGN_IDS) {
        test(`resolve is null and remove is a no-op for ${label}`, async () => {
          const s = makeStore();
          const kept = await s.put(blob('untouched'));
          expect(await s.resolve(id)).toBeNull();
          await expect(s.remove(id)).resolves.toBeUndefined();
          expect(await s.resolve(id)).toBeNull();
          // A foreign id must not collaterally disturb a real asset.
          expect(await bytesAt(s, kept)).toEqual(bytes('untouched'));
        });
      }
    });

    test('metadata does not merge assets: same bytes, different meta, two ids', async () => {
      const s = makeStore();
      const a = await s.put(blob('same pixels'), { contentType: 'image/png', alt: 'first' });
      const b = await s.put(blob('same pixels'), { contentType: 'image/png', alt: 'second' });
      expect(a).not.toBe(b);
      expect(await bytesAt(s, a)).toEqual(bytes('same pixels'));
      expect(await bytesAt(s, b)).toEqual(bytes('same pixels'));
    });

    test('meta is optional and an empty meta object is accepted', async () => {
      const s = makeStore();
      const empty: AssetMeta = {};
      const a = await s.put(blob('no meta'));
      const b = await s.put(blob('empty meta'), empty);
      expect(await bytesAt(s, a)).toEqual(bytes('no meta'));
      expect(await bytesAt(s, b)).toEqual(bytes('empty meta'));
    });
  });
}

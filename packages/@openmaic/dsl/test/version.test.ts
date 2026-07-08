import { describe, it, expect } from 'vitest';
import {
  DSL_VERSION,
  UNVERSIONED_DSL_VERSION,
  INITIAL_DSL_VERSION,
  DSL_VERSION_KEY,
  DSL_MIGRATIONS,
  RUNTIME_DSL_VERSION,
  RUNTIME_DSL_VERSION_KEY,
  RUNTIME_DSL_MIGRATIONS,
  dslVersionOf,
  runtimeDslVersionOf,
  needsMigration,
  needsRuntimeMigration,
  migrate,
  migrateRuntime,
} from '@openmaic/dsl';

describe('DSL_MIGRATIONS ladder invariants', () => {
  it('is a contiguous chain ending at DSL_VERSION', () => {
    expect(DSL_MIGRATIONS.length).toBeGreaterThan(0);
    for (let i = 1; i < DSL_MIGRATIONS.length; i++) {
      // each step's `to` is the next step's `from`
      expect(DSL_MIGRATIONS[i].from).toBe(DSL_MIGRATIONS[i - 1].to);
    }
    expect(DSL_MIGRATIONS[DSL_MIGRATIONS.length - 1].to).toBe(DSL_VERSION);
  });

  it('begins by lifting legacy (unversioned) documents to a pinned endpoint', () => {
    expect(DSL_MIGRATIONS[0].from).toBe(UNVERSIONED_DSL_VERSION);
    // The endpoint is the *pinned* initial version, not the moving DSL_VERSION —
    // so a future step appended from INITIAL_DSL_VERSION isn't skipped once
    // DSL_VERSION moves past it. (They're equal today; the assertion guards the
    // intent, not the current value.)
    expect(DSL_MIGRATIONS[0].to).toBe(INITIAL_DSL_VERSION);
  });
});

describe('RUNTIME_DSL_MIGRATIONS ladder invariants', () => {
  it('is a contiguous chain ending at RUNTIME_DSL_VERSION', () => {
    // The runtime ladder is a *separate* version line from the document ladder
    // (they version independent serialized shapes), but obeys the same
    // contiguity + terminal-endpoint invariants.
    expect(RUNTIME_DSL_MIGRATIONS.length).toBeGreaterThan(0);
    for (let i = 1; i < RUNTIME_DSL_MIGRATIONS.length; i++) {
      expect(RUNTIME_DSL_MIGRATIONS[i].from).toBe(RUNTIME_DSL_MIGRATIONS[i - 1].to);
    }
    expect(RUNTIME_DSL_MIGRATIONS[RUNTIME_DSL_MIGRATIONS.length - 1].to).toBe(RUNTIME_DSL_VERSION);
  });

  it('begins by lifting legacy (unversioned) runtime data', () => {
    expect(RUNTIME_DSL_MIGRATIONS[0].from).toBe(UNVERSIONED_DSL_VERSION);
  });
});

describe('migrateRuntime', () => {
  it('stamps legacy runtime data onto runtimeDslVersion, not the document key', () => {
    const out = migrateRuntime({ id: 'sess' }) as Record<string, unknown>;
    expect(out[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
    // The runtime line never touches the document envelope field.
    expect(out[DSL_VERSION_KEY]).toBeUndefined();
  });

  it('is idempotent and returns non-objects unchanged', () => {
    const once = migrateRuntime({ id: 's' });
    expect(migrateRuntime(once)).toBe(once);
    expect(migrateRuntime(42)).toBe(42);
    expect(migrateRuntime(null)).toBe(null);
  });

  it('leaves a forward-versioned runtime document untouched', () => {
    const future = { id: 's', [RUNTIME_DSL_VERSION_KEY]: '99.0.0' };
    expect(migrateRuntime(future)).toBe(future);
  });

  it('fails loud when the ladder has no path from the runtime version', () => {
    // A runtime version older than RUNTIME_DSL_VERSION with no matching `from`
    // entry — mirrors the document ladder's unbridgeable-stamp case.
    expect(() => migrateRuntime({ id: 's', [RUNTIME_DSL_VERSION_KEY]: '0.0.5' })).toThrow(
      /no migration path/,
    );
  });

  it('fails loud on a malformed stamp', () => {
    expect(() => migrateRuntime({ id: 's', [RUNTIME_DSL_VERSION_KEY]: '0.1' })).toThrow(
      /invalid runtimeDslVersion/,
    );
  });
});

describe('ladder independence (mechanical, disjoint envelope fields)', () => {
  it('document migrate() leaves a runtimeDslVersion stamp untouched', () => {
    // A session stamped on the runtime line, walked by the document runner:
    // migrate reads `dslVersion` (absent), so it lifts the object on the
    // document line and never consumes or mutates `runtimeDslVersion`.
    const session = { id: 's', [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION };
    const out = migrate(session) as Record<string, unknown>;
    expect(out[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
    expect(out[DSL_VERSION_KEY]).toBe(DSL_VERSION);
  });

  it('migrateRuntime() leaves a dslVersion stamp untouched', () => {
    // A document stamped on the document line, walked by the runtime runner:
    // migrateRuntime reads `runtimeDslVersion` (absent) and never mutates
    // `dslVersion`.
    const doc = { id: 'd', [DSL_VERSION_KEY]: DSL_VERSION };
    const out = migrateRuntime(doc) as Record<string, unknown>;
    expect(out[DSL_VERSION_KEY]).toBe(DSL_VERSION);
    expect(out[RUNTIME_DSL_VERSION_KEY]).toBe(RUNTIME_DSL_VERSION);
  });
});

describe('runtimeDslVersionOf', () => {
  it('reads a stamped runtime version and ignores the document key', () => {
    expect(runtimeDslVersionOf({ [RUNTIME_DSL_VERSION_KEY]: '9.9.9' })).toBe('9.9.9');
    // A document-line stamp is invisible to the runtime reader.
    expect(runtimeDslVersionOf({ [DSL_VERSION_KEY]: '9.9.9' })).toBe(UNVERSIONED_DSL_VERSION);
  });
  it('throws on a present-but-malformed runtime stamp', () => {
    expect(() => runtimeDslVersionOf({ [RUNTIME_DSL_VERSION_KEY]: '0.1' })).toThrow(
      /invalid runtimeDslVersion/,
    );
  });
});

describe('needsRuntimeMigration', () => {
  it('is true for unstamped sessions and false at/ahead of the current version', () => {
    expect(needsRuntimeMigration({ id: 'legacy' })).toBe(true);
    expect(needsRuntimeMigration({ [RUNTIME_DSL_VERSION_KEY]: RUNTIME_DSL_VERSION })).toBe(false);
    expect(needsRuntimeMigration({ [RUNTIME_DSL_VERSION_KEY]: '99.0.0' })).toBe(false);
    // A document-line stamp does not satisfy the runtime predicate.
    expect(needsRuntimeMigration({ [DSL_VERSION_KEY]: RUNTIME_DSL_VERSION })).toBe(true);
  });
  it('agrees with migrateRuntime on non-objects (loop terminates)', () => {
    for (const v of [42, null, undefined, 'x', []]) {
      expect(needsRuntimeMigration(v)).toBe(false);
      expect(needsRuntimeMigration(migrateRuntime(v))).toBe(false);
    }
  });
});

describe('dslVersionOf', () => {
  it('reads a stamped version', () => {
    expect(dslVersionOf({ [DSL_VERSION_KEY]: '9.9.9' })).toBe('9.9.9');
  });
  it('treats an unstamped document as unversioned', () => {
    expect(dslVersionOf({ id: 'x' })).toBe(UNVERSIONED_DSL_VERSION);
    expect(dslVersionOf(null)).toBe(UNVERSIONED_DSL_VERSION);
    expect(dslVersionOf('nope')).toBe(UNVERSIONED_DSL_VERSION);
  });
  it('throws on a present-but-malformed stamp (no silent bypass)', () => {
    // "1", "0.1", "0.1.0-beta" would otherwise parse into a comparable version
    // and skip migration entirely.
    for (const bad of ['1', '0.1', '0.1.0-beta', 'x.y.z', '']) {
      expect(() => dslVersionOf({ [DSL_VERSION_KEY]: bad })).toThrow(/invalid dslVersion/);
    }
    expect(() => dslVersionOf({ [DSL_VERSION_KEY]: 3 })).toThrow(/invalid dslVersion/);
  });
});

describe('needsMigration', () => {
  it('is true for legacy documents and false at/ahead of the current version', () => {
    expect(needsMigration({ id: 'legacy' })).toBe(true);
    expect(needsMigration({ [DSL_VERSION_KEY]: DSL_VERSION })).toBe(false);
    expect(needsMigration({ [DSL_VERSION_KEY]: '99.0.0' })).toBe(false);
  });
  it('is false for non-objects (mirrors migrate no-op — never disagree)', () => {
    for (const v of [42, null, undefined, 'x', []]) {
      expect(needsMigration(v)).toBe(false);
      // the invariant: needsMigration and migrate agree on every input
      expect(needsMigration(migrate(v))).toBe(false);
    }
  });
  it('throws on a malformed stamp rather than silently reporting no migration', () => {
    expect(() => needsMigration({ [DSL_VERSION_KEY]: '0.1.0-beta' })).toThrow(/invalid dslVersion/);
  });
});

describe('migrate', () => {
  it('stamps a legacy document up to the current version', () => {
    const out = migrate({ id: 'legacy', name: 'course' }) as Record<string, unknown>;
    expect(out[DSL_VERSION_KEY]).toBe(DSL_VERSION);
    // payload is preserved
    expect(out.id).toBe('legacy');
    expect(out.name).toBe('course');
  });

  it('is idempotent (running twice equals running once)', () => {
    const once = migrate({ id: 'x' });
    const twice = migrate(once);
    expect(twice).toEqual(once);
    // an already-current document is returned by reference (no needless copy)
    expect(migrate(once)).toBe(once);
  });

  it('does not mutate its input', () => {
    const input = { id: 'x' };
    const frozen = Object.freeze({ ...input });
    const out = migrate(frozen);
    expect(out).not.toBe(frozen);
    expect(frozen).toEqual({ id: 'x' }); // untouched, no dslVersion added
  });

  it('leaves a forward-versioned document untouched (no silent downgrade)', () => {
    const future = { id: 'x', [DSL_VERSION_KEY]: '99.0.0', shinyNewField: true };
    expect(migrate(future)).toBe(future);
  });

  it('fails loud when the ladder has no path from the document version', () => {
    // A version older than DSL_VERSION but with no matching `from` entry.
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.0.5' })).toThrow(/no migration path/);
  });

  it('fails loud on a malformed version stamp (no silent no-op)', () => {
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.1' })).toThrow(/invalid dslVersion/);
    expect(() => migrate({ id: 'x', [DSL_VERSION_KEY]: '0.1.0-beta' })).toThrow(
      /invalid dslVersion/,
    );
  });

  it('returns non-object inputs unchanged', () => {
    expect(migrate(42)).toBe(42);
    expect(migrate(null)).toBe(null);
  });
});

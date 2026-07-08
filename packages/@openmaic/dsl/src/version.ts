/**
 * DSL version + migration registry.
 *
 * The DSL version is independent of the npm package version: it identifies the
 * shape of the *serialized* slide contract so that persisted documents can be
 * migrated forward as the schema evolves. A package release can bump for
 * code/API reasons (new exports, refactors) without touching the serialized
 * shape — in which case {@link DSL_VERSION} stays put; conversely the first
 * breaking change to the on-disk shape bumps {@link DSL_VERSION} and appends a
 * migration, regardless of where the package version happens to be.
 *
 * This module owns the *mechanism*: the ordered {@link DSL_MIGRATIONS} ladder,
 * plus the pure {@link migrate} runner that walks a document from whatever
 * version it was written at up to {@link DSL_VERSION}. It carries no runtime
 * dependency, and — like every migration transform — is pure and idempotent.
 *
 * The migratable unit (a {@link Stage} aggregate, a single Scene row, or a
 * bundle of them) is deliberately left open: the runner only needs the
 * {@link DSL_VERSION_KEY} envelope field to read the current version and stamp
 * the new one. Which aggregate carries that field is decided when a normalized
 * store first consumes this pipeline.
 */

/** Current version of the serialized slide contract. */
export const DSL_VERSION = '0.1.0' as const;

export type DslVersion = typeof DSL_VERSION;

/**
 * The version a document is treated as when it carries no {@link DSL_VERSION_KEY}
 * stamp: everything written before the version field existed. The first
 * migration lifts these legacy documents forward.
 */
export const UNVERSIONED_DSL_VERSION = '0.0.0' as const;

/**
 * The first shipped serialized-contract version — a **pinned literal**, not the
 * moving {@link DSL_VERSION}. Migration endpoints must be immutable: they name a
 * fixed point in the ladder, so they cannot reference `DSL_VERSION` (which moves
 * every time the shape changes). It equals `DSL_VERSION` today; the two diverge
 * the moment the first real shape change bumps `DSL_VERSION` and appends a step
 * from here.
 */
export const INITIAL_DSL_VERSION = '0.1.0' as const;

/**
 * Envelope property that carries the serialized-contract version on a document.
 * Named so producers / stores stamp the same field the runner reads.
 */
export const DSL_VERSION_KEY = 'dslVersion' as const;

/**
 * A document that may carry a DSL contract-version stamp. `@openmaic/dsl` does
 * not bind this to a specific aggregate (see the module note) — it is the
 * minimal envelope the {@link migrate} runner reads and writes.
 */
export interface DslVersioned {
  /** Serialized-contract version this document was written at. Absent on legacy data. */
  dslVersion?: string;
}

/**
 * A pure, synchronous transform from one DSL version to the next. Migrations
 * MUST NOT have side effects and MUST NOT depend on any runtime library. They
 * receive and return the whole document; the runner stamps the `to` version, so
 * a transform need only reshape the payload.
 */
export interface DslMigration {
  /** Version this migration upgrades *from*. */
  from: string;
  /** Version this migration upgrades *to*. */
  to: string;
  /** Pure upgrade transform. */
  migrate: (doc: unknown) => unknown;
}

/**
 * Ordered migration ladder. Each entry's `to` is the next entry's `from`, and
 * the last entry's `to` is {@link DSL_VERSION} (both checked by a test). Every
 * `from` / `to` is a **pinned literal** — never the moving `DSL_VERSION`
 * constant — so appending a future step can't retroactively re-target an
 * existing one.
 *
 * The first entry stamps legacy (pre-`dslVersion`) documents up to
 * {@link INITIAL_DSL_VERSION}. It is intentionally a no-op *transform*: bringing
 * `Action` into the contract (#811) and adding validators (#817) did not alter
 * any serialized document, so the current on-disk shape already *is* 0.1.0. The
 * entry exists to wire the pipeline end to end and to give real documents a
 * version stamp to migrate forward from. When the serialized shape first
 * changes, bump {@link DSL_VERSION} *then* and append a real transform from
 * `INITIAL_DSL_VERSION` to the new pinned version.
 */
export const DSL_MIGRATIONS: readonly DslMigration[] = [
  { from: UNVERSIONED_DSL_VERSION, to: INITIAL_DSL_VERSION, migrate: (doc) => doc },
];

/**
 * Current version of the serialized *runtime* contract (#869) — the on-disk
 * shape of a {@link RuntimeSession} / runtime record, NOT the slide document.
 *
 * This is a **deliberately separate version line** from {@link DSL_VERSION}.
 * A {@link RuntimeSession} shares the `dslVersion` envelope *field* (it extends
 * `DslVersioned`), but the two ladders version independent serialized shapes:
 * a change to the document (Stage/Scene) shape must never force — or, worse,
 * accidentally *consume* — a runtime step, and vice versa. A `DslMigration`
 * body is an arbitrary whole-document transform; if runtime sessions rode
 * `DSL_MIGRATIONS`, a future real Stage/Scene migration authored against the
 * document shape would run over a `RuntimeSession` and could corrupt or throw.
 */
export const RUNTIME_DSL_VERSION = '0.1.0' as const;

export type RuntimeDslVersion = typeof RUNTIME_DSL_VERSION;

/**
 * The first shipped runtime-contract version — a **pinned literal**, not the
 * moving {@link RUNTIME_DSL_VERSION} (see {@link INITIAL_DSL_VERSION} for why
 * migration endpoints must be immutable). Equal to `RUNTIME_DSL_VERSION` today;
 * the two diverge the moment the runtime shape first changes.
 */
export const INITIAL_RUNTIME_DSL_VERSION = '0.1.0' as const;

/**
 * Ordered migration ladder for the runtime contract, wholly independent of
 * {@link DSL_MIGRATIONS}. Same invariants (contiguous chain, last `to` ===
 * {@link RUNTIME_DSL_VERSION}, every endpoint a **pinned literal**), same
 * legacy-lift shape: the first entry stamps pre-`dslVersion` runtime data up to
 * {@link INITIAL_RUNTIME_DSL_VERSION} as a no-op transform (the runtime shape is
 * brand new, so nothing predates 0.1.0 to reshape — the entry just wires the
 * pipeline and gives real runtime data a version to migrate forward from).
 *
 * It shares {@link UNVERSIONED_DSL_VERSION} as its legacy origin because that
 * constant names "wrote no `dslVersion` stamp", a property of the shared
 * envelope field, not of either aggregate's shape.
 */
export const RUNTIME_DSL_MIGRATIONS: readonly DslMigration[] = [
  { from: UNVERSIONED_DSL_VERSION, to: INITIAL_RUNTIME_DSL_VERSION, migrate: (doc) => doc },
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A well-formed `x.y.z` version: exactly three non-negative integer parts.
 *
 * Exported so the runtime-envelope validators can reject a present-but-malformed
 * `dslVersion` stamp at their boundary — the same well-formedness rule that
 * {@link dslVersionOf} / {@link migrate} enforce by throwing — rather than
 * letting a bad stamp pass a mere `typeof` check and blow up downstream.
 */
export function isWellFormedDslVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(v);
}

/** Parse a validated `x.y.z` version into numeric parts. */
function parseVersion(v: string): [number, number, number] {
  const [x, y, z] = v.split('.').map((p) => Number.parseInt(p, 10));
  return [x, y, z];
}

/** Pure semver-ish compare over `x.y.z`. Returns <0, 0, or >0. */
function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Read the serialized-contract version a document was written at.
 *
 * - A non-object, or an object with no {@link DSL_VERSION_KEY} field, is treated
 *   as {@link UNVERSIONED_DSL_VERSION} (legacy / pre-versioning data).
 * - A **present but malformed** stamp (not a well-formed `x.y.z` string) is
 *   corrupt data making a false version claim, so this **throws** rather than
 *   letting a bad stamp silently compare as some arbitrary version and bypass
 *   migration.
 */
export function dslVersionOf(doc: unknown): string {
  if (!isObject(doc)) return UNVERSIONED_DSL_VERSION;
  const raw = doc[DSL_VERSION_KEY];
  if (raw === undefined) return UNVERSIONED_DSL_VERSION;
  if (typeof raw !== 'string' || !isWellFormedDslVersion(raw)) {
    throw new Error(
      `@openmaic/dsl: invalid ${DSL_VERSION_KEY} stamp ${JSON.stringify(raw)} (expected "x.y.z")`,
    );
  }
  return raw;
}

/**
 * True when `doc` is a migratable document written at an older version than
 * {@link DSL_VERSION}. A non-object is not a migratable document, so this is
 * `false` for it — mirroring {@link migrate}'s no-op, so the two never disagree
 * (a caller looping `while (needsMigration(x)) x = migrate(x)` always terminates).
 * Throws on an object carrying a malformed stamp (see {@link dslVersionOf}).
 */
export function needsMigration(doc: unknown): boolean {
  if (!isObject(doc)) return false;
  return compareVersions(dslVersionOf(doc), DSL_VERSION) < 0;
}

/** Purely stamp a document's version, returning a new object (never mutating). */
function stampVersion(doc: unknown, version: string): unknown {
  return isObject(doc) ? { ...doc, [DSL_VERSION_KEY]: version } : doc;
}

/**
 * Migrate a document forward to {@link DSL_VERSION}.
 *
 * - Idempotent: a document already at {@link DSL_VERSION} is returned unchanged.
 * - Forward-compatible: a document stamped *newer* than {@link DSL_VERSION} is
 *   returned untouched rather than silently downgraded (mirrors the app's
 *   `migrateSlideContent`). The caller may not render it correctly, but its
 *   on-disk shape survives for the next compatible reader.
 * - Fail-loud: throws (rather than returning a half-migrated document) if the
 *   ladder has no contiguous path from the document's version up to
 *   {@link DSL_VERSION}, or if the document carries a malformed version stamp
 *   (see {@link dslVersionOf}).
 * - A non-object is not a migratable document: it is returned unchanged (and
 *   {@link needsMigration} agrees it needs nothing).
 *
 * Pure: never mutates the input; each step returns a fresh object stamped with
 * its target version.
 */
/**
 * Shared ladder runner behind {@link migrate} and {@link migrateRuntime}. The
 * walk / stamp / fail-loud mechanism is identical for both version lines; only
 * the `ladder` and its `targetVersion` differ, so they are parameters rather
 * than duplicated. This is what keeps the two ladders *independent* — each
 * caller passes its own steps and endpoint, so a document migration can never
 * be walked over runtime data (or vice versa). Behavior is byte-identical to
 * the previous inline `migrate` body.
 */
function runLadder(doc: unknown, ladder: readonly DslMigration[], targetVersion: string): unknown {
  if (!isObject(doc)) return doc;

  let version = dslVersionOf(doc);

  // Already current, or written ahead of us — leave the document as-is.
  if (compareVersions(version, targetVersion) >= 0) return doc;

  let current: unknown = doc;
  // Walk the ladder one step at a time. Guard against a malformed (cyclic /
  // non-advancing) registry so a bad entry can't spin forever.
  for (let step = 0; step < ladder.length + 1; step++) {
    if (version === targetVersion) return current;
    const next = ladder.find((m) => m.from === version);
    if (!next) {
      throw new Error(`@openmaic/dsl: no migration path from "${version}" to "${targetVersion}"`);
    }
    current = stampVersion(next.migrate(current), next.to);
    version = next.to;
  }

  if (version !== targetVersion) {
    throw new Error(
      `@openmaic/dsl: migration ladder did not reach "${targetVersion}" (stuck at "${version}")`,
    );
  }
  return current;
}

export function migrate(doc: unknown): unknown {
  return runLadder(doc, DSL_MIGRATIONS, DSL_VERSION);
}

/**
 * Migrate a runtime document ({@link RuntimeSession} / runtime record) forward
 * to {@link RUNTIME_DSL_VERSION}, walking {@link RUNTIME_DSL_MIGRATIONS}.
 *
 * The exact counterpart of {@link migrate} on the runtime version line —
 * idempotent, forward-compatible, fail-loud, pure, non-objects returned as-is —
 * but pinned to the runtime ladder + target version. Runtime state is stamped
 * and migrated on read through *this* function, never {@link migrate}, so the
 * document and runtime shapes evolve without either ladder consuming the other's
 * data.
 */
export function migrateRuntime(doc: unknown): unknown {
  return runLadder(doc, RUNTIME_DSL_MIGRATIONS, RUNTIME_DSL_VERSION);
}

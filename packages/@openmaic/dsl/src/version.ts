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
 * Envelope property that carries the serialized-contract version on a runtime
 * session. Mechanically **disjoint** from {@link DSL_VERSION_KEY}: the two
 * version lines stamp different fields, so neither ladder can read, consume, or
 * corrupt the other's stamp.
 *
 * Disjoint keys are necessary but **not sufficient** for inertness: an object
 * carrying only this key still *lacks* {@link DSL_VERSION_KEY}, so the document
 * runner would read it as {@link UNVERSIONED_DSL_VERSION} and walk its legacy
 * ladder over the session — stamping a foreign field and, once a real transform
 * lands, mangling the payload. What actually makes misrouted data inert is the
 * cross-line guard in {@link runLadder}: a runner whose own stamp is absent but
 * whose sibling's stamp is present returns the object untouched. See that
 * function for the three-case semantics.
 */
export const RUNTIME_DSL_VERSION_KEY = 'runtimeDslVersion' as const;

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
 * A runtime session that may carry a runtime-contract version stamp. The
 * runtime counterpart of {@link DslVersioned}, stamped by {@link migrateRuntime}
 * on a **different** envelope field ({@link RUNTIME_DSL_VERSION_KEY}) so the two
 * version lines are byte-distinguishable, not convention-separated.
 */
export interface RuntimeVersioned {
  /** Runtime-contract version this session was written at. Absent on legacy data. */
  runtimeDslVersion?: string;
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
 * shape of a {@link RuntimeSession}, NOT the slide document.
 *
 * This is a **deliberately separate version line** from {@link DSL_VERSION},
 * and the separation is mechanical, not by convention: a {@link RuntimeSession}
 * stamps its version on {@link RUNTIME_DSL_VERSION_KEY}, a distinct envelope
 * field from the document's {@link DSL_VERSION_KEY}. The two ladders version
 * independent serialized shapes, so a change to the document (Stage/Scene) shape
 * must never force — or, worse, accidentally *consume* — a runtime step, and
 * vice versa. A `DslMigration` body is an arbitrary whole-document transform;
 * if runtime sessions rode `DSL_MIGRATIONS`, a future real Stage/Scene migration
 * authored against the document shape would run over a `RuntimeSession` and
 * could corrupt or throw.
 *
 * The disjoint stamp fields keep each ladder from reading the other's version,
 * but they do not by themselves stop a misrouted aggregate from being lifted on
 * the wrong line (it simply reads as unversioned there). The cross-line guard in
 * {@link runLadder} is what delivers inertness: a runner returns any aggregate
 * that carries the *sibling* line's stamp but not its own untouched, so a
 * misrouted document migration never even stamps its foreign `dslVersion` onto a
 * runtime session.
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
 * legacy-lift shape: the first entry stamps pre-`runtimeDslVersion` runtime data
 * up to {@link INITIAL_RUNTIME_DSL_VERSION} as a no-op transform (the runtime
 * shape is brand new, so nothing predates 0.1.0 to reshape — the entry just
 * wires the pipeline and gives real runtime data a version to migrate forward
 * from).
 *
 * It shares {@link UNVERSIONED_DSL_VERSION} as its legacy origin because that
 * constant names "wrote no version stamp" — the absence of a stamp, not a shape.
 * Each ladder reads its own envelope field, so the shared origin value never
 * conflates the two lines.
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
 * Exported so the envelope validators can reject a present-but-malformed version
 * stamp (either line's — `dslVersion` or `runtimeDslVersion`) at their boundary
 * — the same well-formedness rule that {@link dslVersionOf} /
 * {@link runtimeDslVersionOf} / {@link migrate} / {@link migrateRuntime} enforce
 * by throwing — rather than letting a bad stamp pass a mere `typeof` check and
 * blow up downstream.
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
 * Read the version an aggregate was written at from an arbitrary envelope
 * `key`. The shared engine behind {@link dslVersionOf} (document line) and
 * {@link runtimeDslVersionOf} (runtime line) — each passes its own key, so the
 * two lines read disjoint fields and never conflate.
 *
 * - A non-object, or an object with no `key` field, is treated as
 *   {@link UNVERSIONED_DSL_VERSION} (legacy / pre-versioning data).
 * - A **present but malformed** stamp (not a well-formed `x.y.z` string) is
 *   corrupt data making a false version claim, so this **throws** rather than
 *   letting a bad stamp silently compare as some arbitrary version and bypass
 *   migration.
 */
function versionOf(doc: unknown, key: string): string {
  if (!isObject(doc)) return UNVERSIONED_DSL_VERSION;
  const raw = doc[key];
  if (raw === undefined) return UNVERSIONED_DSL_VERSION;
  if (typeof raw !== 'string' || !isWellFormedDslVersion(raw)) {
    throw new Error(
      `@openmaic/dsl: invalid ${key} stamp ${JSON.stringify(raw)} (expected "x.y.z")`,
    );
  }
  return raw;
}

/**
 * Read the serialized *document* contract version a document was written at,
 * from its {@link DSL_VERSION_KEY} envelope field. See {@link versionOf} for the
 * unstamped / malformed-stamp rules.
 */
export function dslVersionOf(doc: unknown): string {
  return versionOf(doc, DSL_VERSION_KEY);
}

/**
 * Read the serialized *runtime* contract version a session was written at, from
 * its {@link RUNTIME_DSL_VERSION_KEY} envelope field — the runtime-line
 * counterpart of {@link dslVersionOf}, reading a disjoint field. Same
 * unstamped / malformed-stamp rules (see {@link versionOf}).
 */
export function runtimeDslVersionOf(doc: unknown): string {
  return versionOf(doc, RUNTIME_DSL_VERSION_KEY);
}

/**
 * Shared predicate behind {@link needsMigration} and
 * {@link needsRuntimeMigration}: true when `doc` is an object stamped (on
 * envelope `key`) older than `targetVersion`. It must return `false` for every
 * input its runner leaves untouched, so the predicate and its runner never
 * disagree and a `while (needs…(x)) x = migrate…(x)` loop always terminates.
 * Two such mirrors: a non-object (not a migratable aggregate — the runners
 * return it as-is), and a misrouted aggregate under {@link runLadder}'s
 * cross-line guard (own stamp absent, `otherKey` stamp present — the runner
 * returns it unchanged, so reporting it as needing migration would spin
 * forever). Throws on a malformed own-line stamp (see {@link versionOf}).
 */
function needsLadder(doc: unknown, key: string, targetVersion: string, otherKey: string): boolean {
  if (!isObject(doc)) return false;
  if (doc[key] === undefined && doc[otherKey] !== undefined) return false;
  return compareVersions(versionOf(doc, key), targetVersion) < 0;
}

/**
 * True when `doc` is a migratable document written at an older version than
 * {@link DSL_VERSION}. The document-line predicate (counterpart:
 * {@link needsRuntimeMigration}, which reads the runtime envelope field). It is
 * `false` for every input {@link migrate} leaves untouched — a non-object, and a
 * runtime-line aggregate under the cross-line guard — so the two never disagree
 * (a caller looping `while (needsMigration(x)) x = migrate(x)` always
 * terminates). Throws on an object carrying a malformed stamp (see
 * {@link dslVersionOf}).
 */
export function needsMigration(doc: unknown): boolean {
  return needsLadder(doc, DSL_VERSION_KEY, DSL_VERSION, RUNTIME_DSL_VERSION_KEY);
}

/**
 * True when `doc` is a runtime session written at an older version than
 * {@link RUNTIME_DSL_VERSION}. The runtime-line counterpart of
 * {@link needsMigration}: it reads {@link RUNTIME_DSL_VERSION_KEY} and pairs with
 * {@link migrateRuntime}, so a `while (needsRuntimeMigration(x)) x = migrateRuntime(x)`
 * loop always terminates — including on a misrouted document-line aggregate,
 * which the cross-line guard makes both the predicate and the runner ignore.
 * Pairing {@link needsMigration} with {@link migrateRuntime} (or vice versa)
 * once the lines diverge would spin or silently skip — always pair a predicate
 * with its own line's runner. Throws on a malformed stamp (see
 * {@link runtimeDslVersionOf}).
 */
export function needsRuntimeMigration(doc: unknown): boolean {
  return needsLadder(doc, RUNTIME_DSL_VERSION_KEY, RUNTIME_DSL_VERSION, DSL_VERSION_KEY);
}

/**
 * Purely stamp an aggregate's version onto envelope `key`, returning a new
 * object (never mutating). Keyed so each ladder writes its own line's field.
 */
function stampVersion(doc: unknown, version: string, key: string): unknown {
  return isObject(doc) ? { ...doc, [key]: version } : doc;
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
 * the `ladder`, its `targetVersion`, the own envelope `key`, and the *other*
 * line's `otherKey` differ, so they are parameters rather than duplicated. This
 * is what keeps the two ladders *independent* — each caller passes its own
 * steps, endpoint, and stamp field, so a document migration reads and writes
 * only `dslVersion` while the runtime ladder reads and writes only
 * `runtimeDslVersion`; neither can be walked over the other's stamp.
 *
 * **Cross-line guard.** Disjoint stamp keys alone do NOT make misrouted data
 * inert: an aggregate carrying the *other* line's stamp still lacks this line's
 * key, so `versionOf` reads it as {@link UNVERSIONED_DSL_VERSION} and the runner
 * would walk its own legacy ladder over it — stamping a foreign key and, once a
 * real transform lands on either ladder, mangling or throwing on the other
 * line's payload. The inertness comes from this guard, keyed on the presence of
 * the two stamps:
 *
 * 1. Own line's stamp present → migrate normally on this line, regardless of the
 *    other key (a doubly-stamped envelope is each runner's own line's data).
 * 2. Both stamps absent → genuine legacy data → walk this line's ladder as before.
 * 3. Own stamp ABSENT + other line's stamp PRESENT → this is the *other* line's
 *    aggregate, misrouted here. Return it unchanged: never lift it, never stamp
 *    this line's key onto it.
 */
function runLadder(
  doc: unknown,
  ladder: readonly DslMigration[],
  targetVersion: string,
  key: string,
  otherKey: string,
): unknown {
  if (!isObject(doc)) return doc;

  // Cross-line guard, case (3): this line's stamp absent but the other line's
  // stamp present → the object belongs to the other version line. It is inert
  // here — returned byte-identical, never lifted or stamped. (Cases (1) own
  // stamp present and (2) both absent fall through to the normal walk below,
  // where a present-but-malformed own stamp still throws via `versionOf`.)
  if (doc[key] === undefined && doc[otherKey] !== undefined) return doc;

  let version = versionOf(doc, key);

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
    current = stampVersion(next.migrate(current), next.to, key);
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
  return runLadder(doc, DSL_MIGRATIONS, DSL_VERSION, DSL_VERSION_KEY, RUNTIME_DSL_VERSION_KEY);
}

/**
 * Migrate a {@link RuntimeSession} forward to {@link RUNTIME_DSL_VERSION},
 * walking {@link RUNTIME_DSL_MIGRATIONS} and stamping
 * {@link RUNTIME_DSL_VERSION_KEY}.
 *
 * The exact counterpart of {@link migrate} on the runtime version line —
 * idempotent, forward-compatible, fail-loud, pure, non-objects returned as-is —
 * but pinned to the runtime ladder, target version, and envelope field. Runtime
 * state is stamped and migrated on read through *this* function, never
 * {@link migrate}, so the document and runtime shapes evolve without either
 * ladder consuming the other's data.
 */
export function migrateRuntime(doc: unknown): unknown {
  return runLadder(
    doc,
    RUNTIME_DSL_MIGRATIONS,
    RUNTIME_DSL_VERSION,
    RUNTIME_DSL_VERSION_KEY,
    DSL_VERSION_KEY,
  );
}

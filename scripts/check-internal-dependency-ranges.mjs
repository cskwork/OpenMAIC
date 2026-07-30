import {
  INTERNAL_DEPENDENTS,
  OPENMAIC_PACKAGES,
  assertPackageListIsComplete,
  readManifest,
} from './openmaic-packages.mjs';

/**
 * An owned @openmaic package may be declared as a dependency of another exactly
 * once, in `dependencies`, as `workspace:^`.
 *
 * WHY `workspace:^`. pnpm publishes `workspace:*` as an EXACT pin, so a
 * consumer installing two dependents that were released at different times gets
 * two copies of `@openmaic/dsl`. The dsl carries the schema, the validators and
 * the version constants, so two copies mean a document produced against one
 * instance can be validated by the other instance's schema revision.
 * `workspace:^` publishes as `^<version>` and lets one copy satisfy both.
 *
 * WHY "EXACTLY ONCE, IN `dependencies`". A caret in `dependencies` does not
 * help if a second, tighter constraint on the same package is published
 * alongside it. `peerDependencies` and `optionalDependencies` are both real
 * published constraints that a package manager will enforce, so an exact entry
 * in either reintroduces the duplicate this check exists to prevent while
 * `dependencies` still reads correctly. They are rejected outright: nothing in
 * this family has a reason to declare a sibling as a peer or an optional, and
 * making that a decision someone has to argue for is cheaper than trying to
 * validate the combination.
 *
 * WHERE THIS RUNS. `scripts/smoke-test-package-tarballs.mjs` proves the same
 * thing about the tarball that would actually be published, which is the
 * stronger claim — but it packs and installs four packages, so it runs only on
 * the release path. This is the cheap source-level form, in `ci.yml`, so that a
 * pull request reintroducing an exact pin fails at review time rather than at
 * release time, after a version number has already been spent.
 *
 * KNOWN LIMITATION, deliberately accepted: `^` deduplicates within one 0.x line
 * only. A consumer mixing a dependent that requires `^0.5.0` with one that
 * requires `^0.6.0` still installs two dsl lines. Closing that would mean
 * making the dsl a peer dependency of its dependents, which changes their
 * public installation contract and is out of scope here. What keeps the caret
 * meaningful in the meantime is the rule in `check-package-version-bumps.mjs`
 * that a serialized-format change must cross the dependents' caret boundary.
 */

const OWNED = new Set(OPENMAIC_PACKAGES.map((name) => `@openmaic/${name}`));

/** Published constraint fields in which an owned package must never appear. */
const FORBIDDEN_FIELDS = ['peerDependencies', 'optionalDependencies'];

function report(headline, problems) {
  console.error([headline, ...problems.map((problem) => `- ${problem}`)].join('\n'));
  process.exit(1);
}

// Checked first and fatally: every check below reads this list, so if the list
// itself is wrong there is nothing meaningful to say about what it contains.
const listProblems = assertPackageListIsComplete();
if (listProblems.length > 0) {
  report('The shared @openmaic package list has drifted:', listProblems);
}

const failures = [];
const seen = new Map();

for (const name of OPENMAIC_PACKAGES) {
  const manifest = readManifest(name);

  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!OWNED.has(dependency)) continue;
    seen.set(name, dependency);
    if (range === 'workspace:^') {
      console.log(`@openmaic/${name}: dependencies.${dependency} = ${range}`);
      continue;
    }
    failures.push(
      `@openmaic/${name} declares dependencies."${dependency}" as ${JSON.stringify(range)}. ` +
        'Use "workspace:^": the "workspace:*" form publishes as an exact pin, which forces ' +
        'consumers to install a second copy of that package alongside its siblings.',
    );
  }

  for (const field of FORBIDDEN_FIELDS) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (!OWNED.has(dependency)) continue;
      failures.push(
        `@openmaic/${name} declares ${field}."${dependency}". An owned @openmaic package may ` +
          'be declared exactly once, in `dependencies`. A second published constraint here ' +
          'can pin the same package exactly while `dependencies` still reads as a caret, ' +
          'which reintroduces the duplicate copy this check exists to prevent.',
      );
    }
  }

  // devDependencies are not a constraint any consumer resolves, but the same
  // form keeps the workspace link unambiguous and costs nothing to require.
  for (const [dependency, range] of Object.entries(manifest.devDependencies ?? {})) {
    if (!OWNED.has(dependency)) continue;
    if (range === 'workspace:^') continue;
    failures.push(
      `@openmaic/${name} declares devDependencies."${dependency}" as ${JSON.stringify(range)}; ` +
        'use "workspace:^" for owned packages everywhere.',
    );
  }
}

// A count is not a coverage proof: zero declarations, or three declarations
// that all came from one package, would both pass one. Name what must be there.
for (const [name, expected] of Object.entries(INTERNAL_DEPENDENTS)) {
  const observed = seen.get(name);
  if (observed === undefined) {
    failures.push(
      `@openmaic/${name} no longer declares any owned @openmaic dependency; it was expected ` +
        `to depend on ${expected}. If that is intended, update INTERNAL_DEPENDENTS in ` +
        'scripts/openmaic-packages.mjs — this check must not go quiet on its own.',
    );
    continue;
  }
  if (observed !== expected) {
    failures.push(
      `@openmaic/${name} depends on ${observed}, but INTERNAL_DEPENDENTS expects ${expected}.`,
    );
  }
}

if (failures.length > 0) {
  report('Internal @openmaic dependency declarations are not in the required shape:', failures);
}

console.log(
  `Internal dependency check passed: ${Object.keys(INTERNAL_DEPENDENTS).length} expected ` +
    'dependents each declare their owned dependency exactly once, in `dependencies`, ' +
    'as workspace:^.',
);

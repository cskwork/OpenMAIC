import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every @openmaic package that depends on another must declare it as
 * `workspace:^`, never `workspace:*`.
 *
 * pnpm publishes `workspace:*` as an EXACT pin, so a consumer installing two
 * dependents that were released at different times gets two copies of
 * `@openmaic/dsl`. The dsl carries the schema, the validators and the version
 * constants, so two copies mean a document produced against one instance can be
 * validated by the other instance's schema revision. `workspace:^` publishes as
 * `^<version>` and lets one copy satisfy both.
 *
 * `scripts/smoke-test-package-tarballs.mjs` proves this about the tarball that
 * would actually be published, which is the stronger claim — but it packs and
 * installs four packages, so it runs only on the release path. This is the
 * cheap source-level form of the same rule, so that a pull request restoring
 * `workspace:*` fails at review time rather than at release time, after a
 * version number has already been spent.
 *
 * KNOWN LIMITATION, deliberately accepted: `^` deduplicates within one 0.x line
 * only. A consumer mixing a dependent that requires `^0.5.0` with one that
 * requires `^0.6.0` still installs two dsl lines. Closing that would mean
 * making the dsl a peer dependency of its dependents, which changes their
 * public installation contract and is out of scope here. What keeps the caret
 * meaningful in the meantime is the rule in `check-package-version-bumps.mjs`
 * that a serialized-format change must cross a dsl minor.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Kept in lockstep with publish-packages.yml and check-package-version-bumps.mjs.
const PACKAGES = ['dsl', 'storage', 'renderer', 'importer'];
const OWNED = new Set(PACKAGES.map((name) => `@openmaic/${name}`));

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];

const failures = [];
let checked = 0;

for (const name of PACKAGES) {
  const manifestPath = join(root, 'packages/@openmaic', name, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

  for (const field of DEPENDENCY_FIELDS) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (!OWNED.has(dependency)) continue;
      // A peer range states what a consumer must supply, not what pnpm rewrites
      // on publish, so the workspace protocol does not apply to it.
      if (field === 'peerDependencies') continue;
      checked += 1;
      if (range === 'workspace:^') {
        console.log(`@openmaic/${name}: ${field}.${dependency} = ${range}`);
        continue;
      }
      failures.push(
        `@openmaic/${name} declares ${field}."${dependency}" as ${JSON.stringify(range)}. ` +
          'Use "workspace:^": the "workspace:*" form publishes as an exact pin, which ' +
          'forces consumers to install a second copy of that package alongside its siblings.',
      );
    }
  }
}

if (failures.length > 0) {
  console.error(
    [
      'Internal @openmaic dependency ranges must publish as carets:',
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

if (checked === 0) {
  console.error(
    'No internal @openmaic dependency was found to check. That is not a pass: either the ' +
      'package set above is stale, or the dependency graph changed shape.',
  );
  process.exit(2);
}

console.log(`Internal dependency range check passed (${checked} declarations).`);

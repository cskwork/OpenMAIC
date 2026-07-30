import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one list of owned, publishable @openmaic packages.
 *
 * Several checks and the release workflow each used to carry their own copy of
 * this list, which meant a package missing from one of them was silently exempt
 * from that check rather than failing anything. The scripts now share this
 * module; the workflow cannot import JavaScript into its `on:` trigger, so
 * {@link assertPackageListIsComplete} verifies from the outside that the
 * workflow's own list still agrees with this one.
 *
 * Ordered by dependency: dsl first, since the other three build against it.
 */
export const OPENMAIC_PACKAGES = ['dsl', 'storage', 'renderer', 'importer'];

/** The packages that depend on another owned package, and on which one. */
export const INTERNAL_DEPENDENTS = {
  storage: '@openmaic/dsl',
  renderer: '@openmaic/dsl',
  importer: '@openmaic/dsl',
};

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PACKAGES_DIRECTORY = join(repositoryRoot, 'packages/@openmaic');

export function packageDirectory(name) {
  return `packages/@openmaic/${name}`;
}

export function readManifest(name) {
  return JSON.parse(readFileSync(join(PACKAGES_DIRECTORY, name, 'package.json'), 'utf8'));
}

const PUBLISH_WORKFLOW = '.github/workflows/publish-packages.yml';

/**
 * Fail if this list has drifted from what actually exists on disk, or from the
 * release workflow's own hardcoded copies.
 *
 * Being wrong in either direction is silent by nature: a package present on
 * disk but missing here is exempt from every check that reads this module, and
 * a package here but missing from the workflow is never published. Both read as
 * a pass unless something asserts otherwise, which is what this does.
 *
 * Returns the problems rather than exiting, so a caller can report them
 * alongside its own.
 */
export function assertPackageListIsComplete() {
  const problems = [];

  const onDisk = readdirSync(PACKAGES_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const listed = [...OPENMAIC_PACKAGES].sort();

  for (const name of onDisk) {
    if (!listed.includes(name)) {
      problems.push(
        `packages/@openmaic/${name} exists but is not in OPENMAIC_PACKAGES, so every check ` +
          'that reads this list skips it. Add it there and to publish-packages.yml.',
      );
    }
  }
  for (const name of listed) {
    if (!onDisk.includes(name)) {
      problems.push(`OPENMAIC_PACKAGES lists ${name}, but packages/@openmaic/${name} is gone.`);
    }
  }

  // The workflow's `on.push.paths` trigger and its per-package loops are plain
  // YAML text. Substring checks are coarse, but they do catch the failure that
  // matters: a package added here and forgotten there, which would never
  // publish and never complain.
  let workflow;
  try {
    workflow = readFileSync(join(repositoryRoot, PUBLISH_WORKFLOW), 'utf8');
  } catch {
    problems.push(`${PUBLISH_WORKFLOW} is missing, so its package list cannot be cross-checked.`);
    return problems;
  }
  for (const name of OPENMAIC_PACKAGES) {
    if (!workflow.includes(`packages/@openmaic/${name}/package.json`)) {
      problems.push(
        `${PUBLISH_WORKFLOW} does not list packages/@openmaic/${name}/package.json, so a ` +
          `version bump to ${name} would not trigger a release.`,
      );
    }
    if (!workflow.includes(`@openmaic/${name}`)) {
      problems.push(`${PUBLISH_WORKFLOW} never mentions @openmaic/${name}.`);
    }
  }

  return problems;
}

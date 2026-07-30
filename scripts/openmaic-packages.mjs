import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Shared knowledge about the published @openmaic package family: which packages
 * exist, where they live, and how their versions order.
 *
 * Pure module. Importing it runs no git or npm command and prints nothing, so
 * the three entry points that use it (check-package-version-bumps.mjs,
 * check-changesets.mjs, and the publish loop through `--list`) cannot disagree
 * about the package set.
 */

export const REGISTRY = 'https://registry.npmjs.org';

/**
 * THE ALLOWLIST. Publishing is scoped to exactly these names.
 *
 * The workspace also contains vendored third-party forks (mathml2omml,
 * pptxgenjs) whose npm names belong to their original authors. Marking them
 * `private` keeps tooling away from them, but a `private` flag is a line in a
 * file that a future edit can drop. `assertPublishableSet` turns this list into
 * an executed assertion instead: it fails when the set of publishable workspace
 * packages is not exactly this set, so a fork losing its flag, or a new public
 * package appearing, stops a release rather than silently joining it.
 */
export const PUBLISHABLE_PACKAGES = [
  '@openmaic/dsl',
  '@openmaic/storage',
  '@openmaic/renderer',
  '@openmaic/importer',
];

export function repositoryRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    console.error('This check must run inside a Git worktree.');
    process.exit(2);
  }
}

export function git(args, { cwd = repositoryRoot(), quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    // execFileSync forwards the child's stderr to ours by default, which turns
    // an expected lookup miss into a scary "fatal:" line in the job log.
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : undefined,
  }).trim();
}

export function resolveCommit(ref, cwd) {
  if (!ref) return undefined;
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd, quiet: true });
  } catch {
    return undefined;
  }
}

/** Directory of a published package, relative to the repository root. */
export function packageDirectory(name) {
  return `packages/${name}`;
}

/**
 * Parse a semver version. Prerelease identifiers are kept because the registry
 * holds whatever was ever published: refusing to order them would let one
 * historical `x.y.z-beta.1` block every future release of every package.
 */
export function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw);
  if (!match) return undefined;
  return {
    raw,
    parts: match.slice(1, 4).map(Number),
    prerelease: match[4] === undefined ? undefined : match[4].split('.'),
  };
}

export function isStable(version) {
  return version.prerelease === undefined;
}

/** Semver precedence for prerelease identifiers. */
function comparePrerelease(left, right) {
  if (left === undefined && right === undefined) return 0;
  // A version without a prerelease outranks one with it.
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i];
    const b = right[i];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) - Number(b);
    } else if (aNumeric !== bNumeric) {
      // Numeric identifiers always have lower precedence than alphanumeric.
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

export function compareVersions(left, right) {
  for (let i = 0; i < left.parts.length; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function readVersion(contents, source) {
  const raw = JSON.parse(contents).version;
  const version = parseVersion(raw);
  if (!version || !isStable(version)) {
    throw new Error(`${source} must use a stable x.y.z version, got ${JSON.stringify(raw)}`);
  }
  return version;
}

/** The parts of the changesets configuration these checks depend on. */
export function readChangesetsConfig(root = repositoryRoot()) {
  const config = JSON.parse(readFileSync(join(root, '.changeset', 'config.json'), 'utf8'));
  return {
    ignore: config.ignore ?? [],
  };
}

/**
 * The workspace definition this module knows how to enumerate, pinned literally.
 *
 * `getWorkspacePackages` walks two hard-coded parent directories rather than
 * expanding globs, so the only question pnpm-workspace.yaml has to answer here
 * is "is the layout still the one that walk covers?". That question is answered
 * by comparing the file to this constant. Nothing is parsed, so nothing can
 * disagree with pnpm about what the file means: any edit at all — a new glob, a
 * moved directory, a YAML construct such as an anchor, an alias or a second
 * document — stops the release until someone updates the walk below to match.
 *
 * Deliberately NOT a YAML parse. A hand-rolled line scanner can accept a file
 * whose YAML meaning is different, which is the failure this replaces. A real
 * parser would mean importing one, and these checks run BEFORE `pnpm install` so
 * that a workspace which has grown an unvetted publishable package is rejected
 * without executing any third-party code. Pinning the bytes needs neither and is
 * strictly stricter than both: it cannot misread the file, because it does not
 * read it.
 *
 * The cost is that a comment or formatting change here also has to be made in
 * this constant. The file is four lines and changes about as often.
 */
const EXPECTED_WORKSPACE_FILE = [
  'packages:',
  '  - "packages/*"',
  '  - "packages/@openmaic/*"',
  '  - "!packages/docs" # standalone docs sub-app: own lockfile, build, deploy',
].join('\n');

/** The directories `getWorkspacePackages` walks, and what it skips inside them. */
const WORKSPACE_PARENTS = ['packages', 'packages/@openmaic'];
const WORKSPACE_EXCLUDED = ['packages/docs'];

function bail(message) {
  console.error(message);
  process.exit(2);
}

/** Line endings and trailing whitespace only. No YAML construct is interpreted. */
function normaliseWorkspaceFile(contents) {
  return contents
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
}

function assertWorkspaceLayout(root) {
  const path = join(root, 'pnpm-workspace.yaml');
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    bail(`Cannot read pnpm-workspace.yaml, so the workspace layout is unknown: ${error.message}`);
  }
  if (normaliseWorkspaceFile(contents) === EXPECTED_WORKSPACE_FILE) return;
  bail(
    'pnpm-workspace.yaml is no longer the layout the release checks know how to enumerate.\n' +
      `- found:\n${normaliseWorkspaceFile(contents)}\n` +
      `- expected:\n${EXPECTED_WORKSPACE_FILE}\n` +
      'These checks walk fixed directories rather than expanding globs, so a change here has to ' +
      'be reflected in EXPECTED_WORKSPACE_FILE, WORKSPACE_PARENTS and WORKSPACE_EXCLUDED in ' +
      'scripts/openmaic-packages.mjs before a release can proceed.',
  );
}

/**
 * Every workspace package: name, version, and whether npm would publish it.
 *
 * `private` is the only thing that decides whether a publish offers a package
 * to the registry, so it is the only property this needs to get right.
 */
export function getWorkspacePackages(root = repositoryRoot()) {
  assertWorkspaceLayout(root);

  const packages = [];
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of readdirSync(join(root, parent))) {
      const dir = `${parent}/${entry}`;
      if (WORKSPACE_EXCLUDED.includes(dir)) continue;
      // statSync, not Dirent.isDirectory(): pnpm follows a symlinked package
      // directory, and a Dirent for a symlink reports isDirectory() === false,
      // which would have hidden such a package from every check here.
      let stats;
      try {
        stats = statSync(join(root, dir));
      } catch (error) {
        bail(`Cannot resolve the workspace entry ${dir}: ${error.message}`);
      }
      if (!stats.isDirectory()) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
      } catch (error) {
        // No manifest at all is normal: `packages/*` also matches the
        // `packages/@openmaic` container. An unreadable or invalid one is not.
        if (error.code === 'ENOENT') continue;
        bail(`Cannot read ${dir}/package.json: ${error.message}`);
      }
      if (typeof manifest.name !== 'string' || manifest.name === '') {
        bail(`${dir}/package.json has no name, so it cannot be checked against the allowlist.`);
      }
      packages.push({
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true,
        dir,
      });
    }
  }
  return packages;
}

/**
 * Fail unless the publishable workspace packages are exactly the allowlist.
 *
 * "Publishable" is npm's own rule — every workspace package without
 * `"private": true` — because that is what a publish would offer to the
 * registry. Comparing the two sets in both directions catches a new public
 * package that has passed through none of the release checks, and a vendored
 * fork whose `private` flag has been removed.
 */
export function assertPublishableSet(root = repositoryRoot()) {
  const packages = getWorkspacePackages(root);
  const { ignore } = readChangesetsConfig(root);
  const failures = [];

  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const publishable = packages.filter((pkg) => !pkg.private).map((pkg) => pkg.name);

  const unexpected = publishable.filter((name) => !PUBLISHABLE_PACKAGES.includes(name));
  if (unexpected.length > 0) {
    failures.push(
      `the workspace publishes packages the release path does not know about: ${unexpected.join(', ')}. ` +
        'Add them to PUBLISHABLE_PACKAGES in scripts/openmaic-packages.mjs so they go through the ' +
        'build, tests, tarball inspection and registry preflight, or mark them "private": true.',
    );
  }

  for (const name of PUBLISHABLE_PACKAGES) {
    const pkg = byName.get(name);
    if (!pkg) {
      failures.push(`${name} is on the allowlist but is not a workspace package.`);
      continue;
    }
    if (pkg.private) {
      failures.push(
        `${name} is on the allowlist but is marked "private": true, so it cannot be published.`,
      );
    }
  }

  // A name in `ignore` that is no longer a workspace package, or that is not
  // private, is a hole rather than a harmless leftover: `ignore` keeps a package
  // out of `changeset add/status/version` but has no effect on a publish.
  for (const name of ignore) {
    const pkg = byName.get(name);
    if (!pkg) {
      failures.push(`.changeset/config.json ignores ${name}, which is not a workspace package.`);
      continue;
    }
    if (!pkg.private) {
      failures.push(
        `.changeset/config.json ignores ${name} but its manifest is not "private": true. ` +
          '`ignore` does not reach a publish, so the flag is what keeps it off the registry.',
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      [
        'Refusing to proceed: the publishable package set is not the expected one:',
        ...failures.map((f) => `- ${f}`),
      ].join('\n'),
    );
    process.exit(1);
  }

  return PUBLISHABLE_PACKAGES;
}

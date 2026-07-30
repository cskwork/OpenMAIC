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
 * The workspace layout this module knows how to enumerate.
 *
 * Asserted rather than assumed. Enumerating the workspace without a dependency
 * is what lets the release checks run before `pnpm install`, so nothing
 * third-party executes before a bad release is rejected — but a hand-rolled
 * expansion that silently disagrees with pnpm would be worse than a dependency.
 * So the globs are compared to pnpm-workspace.yaml and any change fails loudly.
 */
const EXPECTED_WORKSPACE_GLOBS = ['packages/*', 'packages/@openmaic/*', '!packages/docs'];

function bail(message) {
  console.error(message);
  process.exit(2);
}

/**
 * The `packages` list from pnpm-workspace.yaml.
 *
 * Deliberately narrow rather than tolerant. It understands one shape — a block
 * sequence of scalars under a top-level `packages:` key, with comments and blank
 * lines — and refuses to guess at anything else. An earlier version stopped at
 * the first line it did not recognise, which made a blank line hide every entry
 * after it while YAML still counted them.
 */
function readWorkspaceGlobs(root) {
  const lines = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8').split('\n');
  const globs = [];
  let index = lines.findIndex((line) => /^packages:/.test(line));
  if (index === -1) bail('pnpm-workspace.yaml has no top-level `packages:` key.');
  if (!/^packages:\s*(#.*)?$/.test(lines[index])) {
    bail(
      `pnpm-workspace.yaml line ${index + 1} puts content on the \`packages:\` key itself ` +
        '(a flow sequence?), which these checks do not parse. Use a block sequence.',
    );
  }

  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment-only
    if (!/^\s/.test(line)) break; // a new top-level key ends the list
    const item = /^\s+-\s+(.+?)\s*(?:\s#.*)?$/.exec(line);
    if (!item) {
      bail(
        `pnpm-workspace.yaml line ${index + 1} is inside \`packages:\` but is not a plain list ` +
          `item, so these checks cannot tell what the workspace contains:\n  ${line}`,
      );
    }
    globs.push(item[1].replace(/^(["'])(.*)\1$/, '$2'));
  }
  if (globs.length === 0) bail('pnpm-workspace.yaml declares an empty `packages:` list.');
  return globs;
}

/**
 * Every workspace package: name, version, and whether npm would publish it.
 *
 * `private` is the only thing that decides whether a publish offers a package
 * to the registry, so it is the only property this needs to get right.
 */
export function getWorkspacePackages(root = repositoryRoot()) {
  const globs = readWorkspaceGlobs(root);
  const expected = [...EXPECTED_WORKSPACE_GLOBS].sort();
  if (JSON.stringify([...globs].sort()) !== JSON.stringify(expected)) {
    bail(
      'pnpm-workspace.yaml no longer matches the layout the release checks know how to enumerate.\n' +
        `- found:    ${JSON.stringify(globs)}\n` +
        `- expected: ${JSON.stringify(EXPECTED_WORKSPACE_GLOBS)}\n` +
        'Update EXPECTED_WORKSPACE_GLOBS and getWorkspacePackages in scripts/openmaic-packages.mjs.',
    );
  }

  const packages = [];
  for (const parent of ['packages', 'packages/@openmaic']) {
    for (const entry of readdirSync(join(root, parent))) {
      const dir = `${parent}/${entry}`;
      if (dir === 'packages/docs') continue;
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

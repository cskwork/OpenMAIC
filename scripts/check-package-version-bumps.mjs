import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const commonIgnoredInputs = {
  files: ['.gitignore', 'vitest.config.ts'],
  directories: ['docs/', 'test/'],
};

// Keep this package set in lockstep with publish-packages.yml. The release
// workflow intentionally publishes only these four owned packages.
const ignoredPackageInputs = {
  dsl: commonIgnoredInputs,
  storage: commonIgnoredInputs,
  renderer: commonIgnoredInputs,
  importer: {
    // These are local tooling, demo assets, or the legacy reference
    // implementation. The importer build and package files exclude all of them.
    files: [
      ...commonIgnoredInputs.files,
      '.babelrc.cjs',
      '.eslintignore',
      '.eslintrc.cjs',
      'DESIGN.md',
      'SKILL.md',
      'favicon.ico',
      'index.html',
    ],
    directories: [...commonIgnoredInputs.directories, 'scripts/', 'src1/'],
  },
};

const usage = [
  'Usage:',
  '  check-package-version-bumps.mjs <base-ref>                   (diff mode)',
  '  check-package-version-bumps.mjs --release [<fallback-base>]  (release mode)',
].join('\n');

let repositoryRoot;
try {
  repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
} catch {
  console.error('Package version checks must run inside a Git worktree.');
  process.exit(2);
}

function git(args, { quiet = false } = {}) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    // execFileSync forwards the child's stderr to ours by default, which turns
    // an expected lookup miss into a scary "fatal:" line in the job log.
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : undefined,
  }).trim();
}

function gitFileAt(ref, file) {
  const path = git(['ls-tree', '--full-tree', '--name-only', ref, '--', file]);
  if (path === '') return undefined;
  return git(['show', `${ref}:${file}`]);
}

function resolveCommit(ref) {
  if (!ref) return undefined;
  try {
    return git(['rev-parse', '--verify', `${ref}^{commit}`], { quiet: true });
  } catch {
    return undefined;
  }
}

function readVersion(contents, source) {
  const version = JSON.parse(contents).version;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`${source} must use a stable x.y.z version, got ${JSON.stringify(version)}`);
  }
  return { raw: version, parts: match.slice(1).map(Number) };
}

function compareVersions(left, right) {
  for (let i = 0; i < left.parts.length; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  return 0;
}

function packageDirectory(name) {
  return `packages/@openmaic/${name}`;
}

/** Whether any publishable input of `name` differs between `base` and HEAD. */
function publishableInputsChanged(name, base) {
  const directory = packageDirectory(name);
  const ignored = ignoredPackageInputs[name];
  const changed = git([
    'diff',
    '--name-only',
    '--no-renames',
    '--diff-filter=ACDMRT',
    `${base}...HEAD`,
    '--',
    directory,
  ])
    .split('\n')
    .filter(Boolean);

  return changed.some((file) => {
    const relative = file.slice(directory.length + 1);
    const isIgnored =
      ignored.files.includes(relative) ||
      ignored.directories.some((prefix) => relative.startsWith(prefix));
    return !isIgnored;
  });
}

function failIfAny(failures, headline) {
  if (failures.length === 0) return;
  console.error([headline, ...failures.map((failure) => `- ${failure}`)].join('\n'));
  process.exit(1);
}

/**
 * Diff mode: every publishable change between `base` and HEAD must carry a
 * version increase. This is the pull-request / branch-push gate.
 */
function runDiffMode(base) {
  if (!resolveCommit(base)) {
    console.error(`Base ref ${JSON.stringify(base)} is not an available commit.`);
    process.exit(2);
  }

  const failures = [];
  for (const name of Object.keys(ignoredPackageInputs)) {
    if (!publishableInputsChanged(name, base)) continue;

    const manifest = `${packageDirectory(name)}/package.json`;
    const beforeContents = gitFileAt(base, manifest);
    if (beforeContents === undefined) {
      failures.push(`${name}: ${manifest} does not exist at ${base}`);
      continue;
    }
    const afterContents = gitFileAt('HEAD', manifest);
    if (afterContents === undefined) {
      failures.push(`${name}: ${manifest} was removed`);
      continue;
    }

    let before;
    let after;
    try {
      before = readVersion(beforeContents, `${manifest} at ${base}`);
      after = readVersion(afterContents, `${manifest} at HEAD`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (compareVersions(after, before) <= 0) {
      failures.push(
        `${name}: publishable package inputs changed but version did not increase ` +
          `(${before.raw} -> ${after.raw})`,
      );
    } else {
      console.log(`${name}: ${before.raw} -> ${after.raw}`);
    }
  }

  failIfAny(
    failures,
    'Every @openmaic publishable package change must ship with a new package version:',
  );
  console.log('Package version check passed.');
}

/** Versions of `name` already on the registry, or undefined if never published. */
function registryVersions(name) {
  try {
    const output = execFileSync('npm', ['view', name, 'versions', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (output === '') return undefined;
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    const stderr = String(error.stderr ?? '');
    if (stderr.includes('E404') || stderr.includes('404 Not Found')) return undefined;
    // Any other failure (network, auth, rate limit) must not be read as "never
    // published" — that would let an unvalidated release through.
    console.error(`Unable to query the registry for ${name}: ${stderr.trim() || error.message}`);
    process.exit(2);
  }
}

function highestVersion(versions) {
  return versions
    .map((version) => {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
      return match ? { raw: version, parts: match.slice(1).map(Number) } : undefined;
    })
    .filter((version) => version !== undefined)
    .sort(compareVersions)
    .pop();
}

/**
 * Release mode: runs inside the publish job, before publishing, for every
 * trigger.
 *
 * `pnpm publish` silently skips a package whose version is already on the
 * registry. That skip is what lets the registry drift away from the source
 * tree: change a package, leave its version alone, and the release is a no-op
 * that reports success. Diff mode cannot cover this on its own — it sees a
 * single push range, and tag / manual runs have no push range at all.
 *
 * So every package is judged against the registry instead, and a version that
 * is already published is accepted only when the source has not moved since
 * that release. The anchor for "since that release" is, in order:
 *
 *   1. the `@openmaic/<name>@<version>` tag the publish job writes after every
 *      successful publish (exact, and independent of the trigger), or
 *   2. `fallbackBase` — the push range of a branch push, which covers packages
 *      released before those tags existed.
 *
 * With neither anchor there is nothing to compare against, so the release stops
 * rather than guessing.
 */
function runReleaseMode(fallbackBase) {
  const resolvedFallback = resolveCommit(fallbackBase);
  if (fallbackBase && !resolvedFallback) {
    console.log(`Fallback base ${JSON.stringify(fallbackBase)} is not available; ignoring it.`);
  }

  const failures = [];
  const releases = [];

  for (const name of Object.keys(ignoredPackageInputs)) {
    const packageName = `@openmaic/${name}`;
    const manifest = join(repositoryRoot, packageDirectory(name), 'package.json');

    let local;
    try {
      local = readVersion(readFileSync(manifest, 'utf8'), `${packageName} package.json`);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const published = registryVersions(packageName);
    if (published === undefined) {
      console.log(`${packageName}: not on the registry yet, ${local.raw} is the first release.`);
      releases.push({ package: packageName, version: local.raw });
      continue;
    }

    if (!published.includes(local.raw)) {
      const highest = highestVersion(published);
      if (highest && compareVersions(local, highest) <= 0) {
        failures.push(
          `${packageName}: ${local.raw} is not greater than the published ${highest.raw}; ` +
            'refusing to release from a stale tree',
        );
        continue;
      }
      console.log(`${packageName}: releasing ${local.raw} (published: ${highest?.raw ?? 'none'}).`);
      releases.push({ package: packageName, version: local.raw });
      continue;
    }

    // Already on the registry: this run cannot change it, so the source has to
    // still be the source that produced it.
    const releaseTag = `${packageName}@${local.raw}`;
    const taggedRelease = resolveCommit(releaseTag);
    const anchor = taggedRelease ?? resolvedFallback;
    if (!anchor) {
      failures.push(
        `${packageName}: ${local.raw} is already on the registry and there is no release ` +
          `anchor to verify it against (no ${releaseTag} tag, and this trigger has no push ` +
          'range). Bump the version to publish the current source, or tag the commit that ' +
          `released ${local.raw} as ${releaseTag}.`,
      );
      continue;
    }

    if (publishableInputsChanged(name, anchor)) {
      failures.push(
        `${packageName}: publishable inputs changed since ` +
          `${taggedRelease ? releaseTag : anchor.slice(0, 12)} but the version is still ` +
          `${local.raw}, which is already on the registry. \`pnpm publish\` would skip it and ` +
          'leave the registry behind the source. Bump the version.',
      );
      continue;
    }

    console.log(`${packageName}: ${local.raw} already published and unchanged, will be skipped.`);
  }

  failIfAny(failures, 'Refusing to publish @openmaic packages:');

  // The release tags the next run will use as its anchor. Written only once the
  // checks pass, and consumed only after the publish itself has succeeded.
  const planPath = process.env.RELEASE_PLAN_PATH;
  if (planPath) {
    writeFileSync(planPath, `${JSON.stringify(releases, null, 2)}\n`);
    console.log(`Wrote the release plan for ${releases.length} package(s) to ${planPath}.`);
  }

  console.log('Release version check passed.');
}

const args = process.argv.slice(2);
if (args[0] === '--release') {
  runReleaseMode(args[1]);
} else if (args.length > 0 && !args[0].startsWith('--')) {
  runDiffMode(args[0]);
} else {
  console.error(usage);
  process.exit(2);
}

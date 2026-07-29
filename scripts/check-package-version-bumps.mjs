import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY = 'https://registry.npmjs.org';

const commonIgnoredInputs = {
  files: ['.gitignore', 'vitest.config.ts'],
  directories: ['docs/', 'test/'],
};

// Keep this package set in lockstep with publish-packages.yml. The release
// workflow intentionally publishes only these four owned packages.
//
// KNOWN LIMITATION: this treats "publishable input" as "file under the package
// directory". That is exact for dsl and storage, which build with tsc and
// declare every runtime dependency. It is an under-approximation for renderer
// and importer, whose Rollup configs inline their dependency graph, so a
// lockfile-only resolution change can alter their published bytes with no diff
// under the package directory. Closing that would mean either marking those
// dependencies external or treating the lockfile as an input of every bundling
// package, both of which are changes to how the packages are built rather than
// to this check. Diff mode is therefore a merge-time guard against the common
// case, not a proof of byte equality.
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
  '  check-package-version-bumps.mjs <base-ref>   (diff mode, merge-time gate)',
  '  check-package-version-bumps.mjs --release    (release mode, pre-publish gate)',
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

function parseVersion(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!match) return undefined;
  return { raw, parts: match.slice(1).map(Number) };
}

function readVersion(contents, source) {
  const raw = JSON.parse(contents).version;
  const version = parseVersion(raw);
  if (!version) {
    throw new Error(`${source} must use a stable x.y.z version, got ${JSON.stringify(raw)}`);
  }
  return version;
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
 * version increase.
 *
 * This is where drift is actually prevented. It runs on pull requests and on
 * pushes to main, where a real push range always exists, so it sees every
 * commit that can change a package before that change is reachable by a
 * release.
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
    const afterContents = gitFileAt('HEAD', manifest);
    if (afterContents === undefined) {
      failures.push(`${name}: ${manifest} was removed`);
      continue;
    }
    if (beforeContents === undefined) {
      console.log(`${name}: new package at ${base}, nothing to compare.`);
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

/**
 * Versions of `name` already on the registry.
 *
 * Returns `undefined` only for a definitive "this package does not exist"
 * answer. Every other outcome — a transient error, an auth or proxy failure, an
 * unparseable body, a registry that is not the one we publish to — exits
 * non-zero, because reading "unknown" as "never published" would skip the
 * checks below entirely.
 */
function registryVersions(name) {
  let stdout = '';
  let stderr = '';
  let failed = false;
  try {
    stdout = execFileSync('npm', ['view', name, 'versions', '--json', '--registry', REGISTRY], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    failed = true;
    stdout = String(error.stdout ?? '');
    stderr = String(error.stderr ?? '');
  }

  const body = stdout.trim();
  if (body !== '') {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      console.error(`Registry response for ${name} was not JSON: ${body.slice(0, 200)}`);
      process.exit(2);
    }
    // npm --json reports errors as an object with an `error` member.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
      if (parsed.error.code === 'E404') return undefined;
      console.error(`Registry error for ${name}: ${parsed.error.code} ${parsed.error.summary ?? ''}`);
      process.exit(2);
    }
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed;
    if (typeof parsed === 'string') return [parsed];
    console.error(`Unexpected registry payload for ${name}: ${body.slice(0, 200)}`);
    process.exit(2);
  }

  if (failed && /E404|404 Not Found/.test(stderr)) return undefined;
  console.error(
    `Unable to determine the published versions of ${name}: ${stderr.trim() || 'empty response'}`,
  );
  process.exit(2);
}

/**
 * Release mode: runs inside the publish job, before publishing, for every
 * trigger.
 *
 * Scope note. An earlier revision of this gate also tried to prove, at publish
 * time, that a package whose version is already on the registry still matches
 * the source that produced it. There is no trustworthy record to prove that
 * against: git tags are mutable and can be created or moved by hand, pnpm does
 * not record `gitHead`, and a push range describes one push rather than the
 * origin of a release. Every anchor available here is either forgeable or
 * missing for packages released before the scheme existed, and treating a
 * forgeable anchor as authoritative is worse than not checking, because it
 * turns "unproven" into "proven".
 *
 * So drift is prevented where it is provable — diff mode, at merge time, on
 * every push to main — and this gate is limited to the claims a release can
 * actually establish:
 *
 *   1. every version about to be published is new and moves forward, so a
 *      release can never quietly reuse or downgrade a published version;
 *   2. a package whose version is already published is reported and left
 *      alone, so `pnpm publish` skipping it is a stated outcome rather than a
 *      silent one;
 *   3. anything the registry cannot answer definitively stops the release.
 *
 * The workflow adds the two guarantees that do not belong in a script: real
 * publishes only happen from a commit contained in `main`, and each package is
 * published and tagged individually so a partial failure stays retryable.
 */
function runReleaseMode() {
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

    if (published.includes(local.raw)) {
      console.log(
        `${packageName}: ${local.raw} is already published; this run will not republish it.`,
      );
      continue;
    }

    // Compare against every published version, not only the stable ones: a
    // prerelease or a version this repository cannot express still occupies its
    // number on the registry, and releasing "past" it would be a downgrade.
    const unparsable = published.filter((version) => parseVersion(version) === undefined);
    const stable = published.map(parseVersion).filter((version) => version !== undefined);
    if (unparsable.length > 0) {
      failures.push(
        `${packageName}: the registry holds versions this check cannot order ` +
          `(${unparsable.slice(0, 5).join(', ')}). Releasing ${local.raw} past them cannot be ` +
          'verified here; publish manually or extend this check with full semver ordering.',
      );
      continue;
    }
    if (stable.length === 0) {
      failures.push(`${packageName}: the registry reports no usable versions; refusing to guess.`);
      continue;
    }
    const highest = stable.sort(compareVersions).pop();
    if (compareVersions(local, highest) <= 0) {
      failures.push(
        `${packageName}: ${local.raw} is not greater than the published ${highest.raw}; ` +
          'refusing to release from a stale tree',
      );
      continue;
    }

    console.log(`${packageName}: releasing ${local.raw} (published: ${highest.raw}).`);
    releases.push({ package: packageName, version: local.raw });
  }

  failIfAny(failures, 'Refusing to publish @openmaic packages:');

  const planPath = process.env.RELEASE_PLAN_PATH;
  if (planPath) {
    writeFileSync(planPath, `${JSON.stringify(releases, null, 2)}\n`);
    console.log(`Wrote the release plan for ${releases.length} package(s) to ${planPath}.`);
  }

  if (releases.length === 0) {
    console.log('Nothing to release: every package version is already on the registry.');
  }
  console.log('Release version check passed.');
}

const args = process.argv.slice(2);
if (args[0] === '--release') {
  runReleaseMode();
} else if (args.length > 0 && !args[0].startsWith('--')) {
  runDiffMode(args[0]);
} else {
  console.error(usage);
  process.exit(2);
}

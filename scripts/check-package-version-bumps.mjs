import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PUBLISHABLE_PACKAGES,
  REGISTRY,
  assertPublishableSet,
  compareVersions,
  packageDirectory,
  parseVersion,
  readVersion,
  repositoryRoot,
} from './openmaic-packages.mjs';

/**
 * The pre-publish gate for the @openmaic package family.
 *
 * The merge-time half of this file — "a publishable change must carry a version
 * increase" — is gone, because versions are no longer typed by hand: changesets
 * computes them, and scripts/check-changesets.mjs enforces at merge time that a
 * changed package carries a declared release. What remains is the part a release
 * still has to establish for itself, against the registry, from the tree it is
 * about to publish.
 */

const usage = [
  'Usage:',
  '  check-package-version-bumps.mjs --release      registry preflight, writes RELEASE_PLAN_PATH',
  '  check-package-version-bumps.mjs --assert-set   only assert the publishable package set',
  '  check-package-version-bumps.mjs --list         assert the set, then print "<name> <dir>" lines',
].join('\n');

const root = repositoryRoot();

function failIfAny(failures, headline) {
  if (failures.length === 0) return;
  console.error([headline, ...failures.map((failure) => `- ${failure}`)].join('\n'));
  process.exit(1);
}

/**
 * Versions of `name` already on the registry.
 *
 * Returns `undefined` only for a definitive "this package does not exist"
 * answer, and that means exactly one thing: a structured
 * `{"error":{"code":"E404"}}` body on stdout. Every other outcome — a transient
 * error, an auth or proxy failure, an unparseable body, a registry that is not
 * the one we publish to — exits non-zero, because reading "unknown" as "never
 * published" would skip the checks below entirely.
 *
 * There is deliberately no fallback that looks for "404" in stderr. npm writes
 * the structured object to stdout for a genuinely missing package, so such a
 * fallback could only ever match something else — a proxy or CDN error page
 * whose text happens to contain "404 Not Found" — and it would turn that into
 * "this package was never published", the most dangerous wrong answer available
 * here.
 */
function registryVersions(name) {
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync('npm', ['view', name, 'versions', '--json', '--registry', REGISTRY], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
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
      console.error(
        `Registry error for ${name}: ${parsed.error.code} ${parsed.error.summary ?? ''}`,
      );
      process.exit(2);
    }
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed;
    if (typeof parsed === 'string') return [parsed];
    console.error(`Unexpected registry payload for ${name}: ${body.slice(0, 200)}`);
    process.exit(2);
  }

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
 * So drift is prevented where it is provable — at merge time, on every pull
 * request and every push to main, by scripts/check-changesets.mjs — and this
 * gate is limited to the claims a release can actually establish:
 *
 *   1. the publishable workspace packages are exactly the allowlist, so the set
 *      that is validated and the set that is published cannot diverge;
 *   2. every version about to be published is new and moves forward, so a
 *      release can never quietly reuse or downgrade a published version;
 *   3. a package whose version is already published is reported and left
 *      alone, so the publish loop skipping it is a stated outcome rather than a
 *      silent one;
 *   4. anything the registry cannot answer definitively stops the release.
 *
 * The workflow adds the two guarantees that do not belong in a script: real
 * publishes only happen from a commit contained in `main`, and each package is
 * published and tagged individually so a partial failure stays retryable.
 */
function runReleaseMode() {
  assertPublishableSet(root);

  const failures = [];
  const releases = [];

  for (const packageName of PUBLISHABLE_PACKAGES) {
    const manifest = join(root, packageDirectory(packageName), 'package.json');

    let local;
    try {
      local = readVersion(readFileSync(manifest, 'utf8'), `${packageName} package.json`);
    } catch (error) {
      failures.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const published = registryVersions(packageName);
    if (published === undefined) {
      console.log(`${packageName}: not on the registry yet, ${local.raw} is the first release.`);
      releases.push({ package: packageName, version: local.raw });
      continue;
    }

    // Order against every published version, prereleases included: each one
    // occupies its number on the registry, so discarding them could let a
    // release move backwards.
    const unparsable = published.filter((version) => parseVersion(version) === undefined);
    if (unparsable.length > 0) {
      failures.push(
        `${packageName}: the registry holds versions that are not semver ` +
          `(${unparsable.slice(0, 5).join(', ')}); refusing to order ${local.raw} against them.`,
      );
      continue;
    }
    const parsed = published.map(parseVersion).filter((version) => version !== undefined);
    if (parsed.length === 0) {
      failures.push(`${packageName}: the registry reports no usable versions; refusing to guess.`);
      continue;
    }
    const highest = [...parsed].sort(compareVersions).pop();

    if (published.includes(local.raw)) {
      // Being behind the registry is not a harmless no-op. `pnpm publish`
      // resolves each `workspace:` dependency against the version in this tree,
      // so a sibling released alongside a rolled-back package would be published
      // declaring a dependency on the older one.
      if (compareVersions(local, highest) < 0) {
        failures.push(
          `${packageName}: the tree is at ${local.raw} while ${highest.raw} is published. ` +
            'Refusing to release from a tree that is behind the registry: any sibling ' +
            `published from it would declare a dependency on ${local.raw}.`,
        );
        continue;
      }
      console.log(
        `${packageName}: ${local.raw} is already published; this run will not republish it.`,
      );
      continue;
    }

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
} else if (args[0] === '--assert-set') {
  assertPublishableSet(root);
  console.log(`Publishable workspace packages are exactly: ${PUBLISHABLE_PACKAGES.join(', ')}.`);
} else if (args[0] === '--list') {
  // Every consumer of this list re-runs the assertion, so no loop can iterate a
  // package set that has not been approved.
  assertPublishableSet(root);
  for (const name of PUBLISHABLE_PACKAGES) {
    process.stdout.write(`${name} ${packageDirectory(name)}\n`);
  }
} else {
  console.error(usage);
  process.exit(2);
}

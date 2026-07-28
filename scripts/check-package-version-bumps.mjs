import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const packages = ['dsl', 'storage', 'renderer', 'importer'];
const base = process.argv[2];

if (!base) {
  console.error('Usage: pnpm check:package-versions <base-ref>');
  process.exit(2);
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
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

const changedFiles = new Set(
  git(['diff', '--name-only', '--no-renames', '--diff-filter=ACDMR', base, 'HEAD'])
    .split('\n')
    .filter(Boolean),
);

const failures = [];

for (const name of packages) {
  const directory = `packages/@openmaic/${name}`;
  const sourcePrefix = `${directory}/src/`;
  const sourceChanged = [...changedFiles].some((file) => file.startsWith(sourcePrefix));
  if (!sourceChanged) continue;

  const manifest = `${directory}/package.json`;
  const before = readVersion(git(['show', `${base}:${manifest}`]), `${manifest} at ${base}`);
  const after = readVersion(readFileSync(manifest, 'utf8'), manifest);

  if (compareVersions(after, before) <= 0) {
    failures.push(
      `${name}: source changed but version did not increase (${before.raw} -> ${after.raw})`,
    );
  } else {
    console.log(`${name}: ${before.raw} -> ${after.raw}`);
  }
}

if (failures.length > 0) {
  console.error(
    [
      'Every @openmaic package source change must ship with a new package version:',
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log('Package version check passed.');

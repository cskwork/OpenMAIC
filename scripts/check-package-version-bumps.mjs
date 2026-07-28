import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

for (const [name, ignored] of Object.entries(ignoredPackageInputs)) {
  const directory = `packages/@openmaic/${name}`;
  const packageChanged = [...changedFiles].some((file) => {
    if (!file.startsWith(`${directory}/`)) return false;
    const relative = file.slice(directory.length + 1);
    const isIgnored =
      ignored.files.includes(relative) ||
      ignored.directories.some((prefix) => relative.startsWith(prefix));
    return !isIgnored;
  });
  if (!packageChanged) continue;

  const manifest = `${directory}/package.json`;
  const before = readVersion(git(['show', `${base}:${manifest}`]), `${manifest} at ${base}`);
  const after = readVersion(readFileSync(manifest, 'utf8'), manifest);

  if (compareVersions(after, before) <= 0) {
    failures.push(
      `${name}: publishable package inputs changed but version did not increase ` +
        `(${before.raw} -> ${after.raw})`,
    );
  } else {
    console.log(`${name}: ${before.raw} -> ${after.raw}`);
  }
}

if (failures.length > 0) {
  console.error(
    [
      'Every @openmaic publishable package change must ship with a new package version:',
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log('Package version check passed.');

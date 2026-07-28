import { execFileSync } from 'node:child_process';

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
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

if (!base) {
  console.error('Usage: pnpm check:package-versions <base-ref>');
  process.exit(2);
}

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
}

function gitFileAt(ref, file) {
  const path = git(['ls-tree', '--full-tree', '--name-only', ref, '--', file]);
  if (path === '') return undefined;
  return git(['show', `${ref}:${file}`]);
}

try {
  git(['rev-parse', '--verify', `${base}^{commit}`]);
} catch {
  console.error(`Base ref ${JSON.stringify(base)} is not an available commit.`);
  process.exit(2);
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
  git(['diff', '--name-only', '--no-renames', '--diff-filter=ACDMRT', base, 'HEAD'])
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

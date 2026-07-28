import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmaic-package-smoke-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
  });
}

function pack(name) {
  const packageDirectory = join(root, 'packages', '@openmaic', name);
  run('pnpm', ['pack', '--pack-destination', temporaryDirectory], {
    cwd: packageDirectory,
    stdio: 'pipe',
  });
  const prefix = `openmaic-${name}-`;
  const tarball = readdirSync(temporaryDirectory).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'),
  );
  assert(tarball, `pnpm pack did not produce a tarball for @openmaic/${name}`);
  console.log(`Packed @openmaic/${name}.`);
  return join(temporaryDirectory, tarball);
}

try {
  const packageNames = ['dsl', 'storage', 'renderer', 'importer'];
  const peerDependencies = {};
  for (const name of packageNames) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/@openmaic', name, 'package.json'), 'utf8'),
    );
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const isOptional = manifest.peerDependenciesMeta?.[peer]?.optional === true;
      if (isOptional && name !== 'renderer') continue;
      const existing = peerDependencies[peer];
      assert(
        existing === undefined || existing === range,
        `@openmaic packages declare different ${peer} peer ranges: ${existing} and ${range}`,
      );
      peerDependencies[peer] = range;
    }
  }
  const tarballs = Object.fromEntries(packageNames.map((name) => [name, pack(name)]));
  const consumerDirectory = join(temporaryDirectory, 'consumer');

  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          ...peerDependencies,
          ...Object.fromEntries(
            packageNames.map((name) => [`@openmaic/${name}`, `file:${tarballs[name]}`]),
          ),
        },
      },
      null,
      2,
    ),
  );

  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: consumerDirectory,
  });

  writeFileSync(
    join(consumerDirectory, 'smoke.mjs'),
    `import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { RUNTIME_DSL_VERSION, validateRuntimeSession } from '@openmaic/dsl';
import { DOCUMENT_PG_SCHEMA } from '@openmaic/storage';
import { SlideCanvas } from '@openmaic/renderer';

assert.equal(typeof RUNTIME_DSL_VERSION, 'string');
assert.equal(typeof validateRuntimeSession, 'function');
assert.match(DOCUMENT_PG_SCHEMA, /CREATE TABLE IF NOT EXISTS document_stages/);
assert.equal(typeof SlideCanvas, 'function');

const importerEntry = fileURLToPath(import.meta.resolve('@openmaic/importer'));
assert((await stat(importerEntry)).isFile());
const importerRequireEntry = createRequire(import.meta.url).resolve('@openmaic/importer');
assert((await stat(importerRequireEntry)).isFile());

for (const subpath of [
  'runtime/http',
  'document/http',
  'document/pg',
  'runtime/pg',
  'server',
  'server/reference',
]) {
  await import(\`@openmaic/storage/\${subpath}\`);
}
`,
  );
  run('node', ['smoke.mjs'], { cwd: consumerDirectory });

  console.log('Packed @openmaic package imports passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'openmaic-package-smoke-'));

function run(command, args, options = {}) {
  execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'inherit',
  });
}

function pack(name) {
  const packageDirectory = join(root, 'packages', '@openmaic', name);
  run('pnpm', ['pack', '--pack-destination', temporaryDirectory], { cwd: packageDirectory });
  const prefix = `openmaic-${name}-`;
  const tarball = readdirSync(temporaryDirectory).find(
    (entry) => entry.startsWith(prefix) && entry.endsWith('.tgz'),
  );
  assert(tarball, `pnpm pack did not produce a tarball for @openmaic/${name}`);
  return join(temporaryDirectory, tarball);
}

try {
  const dslTarball = pack('dsl');
  const storageTarball = pack('storage');
  const consumerDirectory = join(temporaryDirectory, 'consumer');

  mkdirSync(consumerDirectory);
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    JSON.stringify(
      {
        private: true,
        type: 'module',
        dependencies: {
          '@openmaic/dsl': `file:${dslTarball}`,
          '@openmaic/storage': `file:${storageTarball}`,
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
import { RUNTIME_DSL_VERSION, validateRuntimeSession } from '@openmaic/dsl';
import { DOCUMENT_PG_SCHEMA } from '@openmaic/storage';

assert.equal(typeof RUNTIME_DSL_VERSION, 'string');
assert.equal(typeof validateRuntimeSession, 'function');
assert.match(DOCUMENT_PG_SCHEMA, /CREATE TABLE IF NOT EXISTS document_stages/);

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

  console.log('Packed @openmaic/dsl and @openmaic/storage imports passed.');
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

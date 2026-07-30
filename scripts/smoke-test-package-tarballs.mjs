import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

/** The manifest as the registry will see it, read out of the tarball itself. */
function packedManifest(tarball) {
  return JSON.parse(
    execFileSync('tar', ['-xzOf', tarball, 'package/package.json'], { encoding: 'utf8' }),
  );
}

/**
 * The dependents declare `@openmaic/dsl` as `workspace:^`, which pnpm publishes
 * as `^<dsl version>`. That range is what lets a consumer installing several
 * @openmaic packages together resolve ONE copy of the dsl. An exact pin — which
 * is what the `workspace:*` form publishes — gives each dependent its own copy,
 * and since the dsl carries the schema, the validators and the version
 * constants, two copies mean a document produced against one instance can be
 * validated by the other's schema revision.
 *
 * KNOWN LIMITATION: `^` deduplicates within one 0.x line only. A consumer that
 * mixes an older dependent requiring `^0.5.0` with a newer one requiring
 * `^0.6.0` still ends up with two dsl copies. Removing that possibility
 * entirely would mean making the dsl a peer dependency of all three dependents,
 * which changes their public installation contract and is a separate decision.
 */
function assertDeduplicableDslRange(name, manifest, dslVersion) {
  const range = manifest.dependencies?.['@openmaic/dsl'];
  assert(
    range !== undefined,
    `@openmaic/${name} no longer declares @openmaic/dsl; update this check if that is intended`,
  );
  assert.equal(
    range,
    `^${dslVersion}`,
    `@openmaic/${name} publishes @openmaic/dsl as ${JSON.stringify(range)} rather than ` +
      `"^${dslVersion}". An exact pin (what "workspace:*" publishes) forces consumers to ` +
      'install a second copy of the dsl alongside its siblings.',
  );
  console.log(`@openmaic/${name} publishes @openmaic/dsl as ${range}.`);
}

try {
  const packageNames = ['dsl', 'storage', 'renderer', 'importer'];
  const localPackages = new Set(packageNames.map((name) => `@openmaic/${name}`));
  // The smoke program executes the renderer root, whose optional chart and
  // highlighting peers are imported by that entry. Other optional peers remain
  // optional unless the smoke program starts executing their owning entry.
  const installOptionalPeersFor = new Set(['renderer']);
  const peerDependencies = {};
  for (const name of packageNames) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'packages/@openmaic', name, 'package.json'), 'utf8'),
    );
    for (const [peer, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (localPackages.has(peer)) continue;
      const isOptional = manifest.peerDependenciesMeta?.[peer]?.optional === true;
      if (isOptional && !installOptionalPeersFor.has(name)) continue;
      const existing = peerDependencies[peer];
      // Keep peer declarations aligned across the package family. Attempting to
      // synthesize an intersection here is unsafe for ranges containing `||`.
      assert(
        existing === undefined || existing === range,
        `@openmaic packages declare different ${peer} peer ranges: ${existing} and ${range}`,
      );
      peerDependencies[peer] = range;
    }
  }
  const tarballs = Object.fromEntries(packageNames.map((name) => [name, pack(name)]));

  const dslVersion = packedManifest(tarballs.dsl).version;
  for (const name of ['storage', 'renderer', 'importer']) {
    assertDeduplicableDslRange(name, packedManifest(tarballs[name]), dslVersion);
  }

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

// Build-time JSON Schema codegen for @openmaic/dsl.
//
// Runs ts-json-schema-generator (a devDependency) over the TS contract and
// emits static dist/schema/*.json for non-TS / bring-your-own-validator
// consumers. The generator is BUILD-ONLY — the package keeps zero runtime deps.
import { createGenerator } from 'ts-json-schema-generator';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

/** Schema root type -> { file: source it lives in, out: emitted filename }. */
export const ROOTS = {
  Stage: { file: 'src/stage.ts', out: 'stage.schema.json' },
  SerializedScene: { file: 'src/schema-roots.ts', out: 'scene.schema.json' },
  Action: { file: 'src/action.ts', out: 'action.schema.json' },
};

/** Generate the JSON Schema object for one root type (in-memory). */
export function generateSchema(typeName) {
  const root = ROOTS[typeName];
  if (!root) throw new Error(`unknown schema root: ${typeName}`);
  return createGenerator({
    path: resolve(pkgRoot, root.file),
    tsconfig: resolve(pkgRoot, 'tsconfig.json'),
    type: typeName,
    skipTypeCheck: true,
    topRef: true,
  }).createSchema(typeName);
}

function main() {
  const outDir = resolve(pkgRoot, 'dist/schema');
  mkdirSync(outDir, { recursive: true });
  for (const [typeName, { out }] of Object.entries(ROOTS)) {
    writeFileSync(resolve(outDir, out), JSON.stringify(generateSchema(typeName), null, 2) + '\n');
    console.log(`wrote dist/schema/${out}`);
  }
}

// Run only when invoked directly (`node scripts/gen-schema.mjs`).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

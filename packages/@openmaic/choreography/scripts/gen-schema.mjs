// Build-time JSON Schema codegen for @openmaic/choreography.
//
// Runs ts-json-schema-generator (a devDependency) over the animation-descriptor
// TS types and emits static dist/schema/*.json, so descriptors are
// schema-validated (see test/descriptors.test.ts) and non-TS consumers can
// validate their own. The generator is BUILD-ONLY — the package keeps a single
// runtime dependency (@openmaic/dsl).
import { createGenerator } from 'ts-json-schema-generator';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');

/** Schema root type -> emitted filename. */
export const ROOTS = {
  AnimationDescriptor: 'animation-descriptor.schema.json',
};

// One generator over the whole tsconfig program, built lazily and reused for
// every root — parses/type-builds the program once instead of per type.
let generator;
function getGenerator() {
  generator ??= createGenerator({
    tsconfig: resolve(pkgRoot, 'tsconfig.json'),
    skipTypeCheck: true,
    topRef: true,
    jsDoc: 'extended',
  });
  return generator;
}

/** Generate the JSON Schema object for one root type (in-memory). */
export function generateSchema(typeName) {
  if (!(typeName in ROOTS)) throw new Error(`unknown schema root: ${typeName}`);
  return getGenerator().createSchema(typeName);
}

function main() {
  const outDir = resolve(pkgRoot, 'dist/schema');
  mkdirSync(outDir, { recursive: true });
  for (const [typeName, out] of Object.entries(ROOTS)) {
    writeFileSync(resolve(outDir, out), JSON.stringify(generateSchema(typeName), null, 2) + '\n');
    console.log(`wrote dist/schema/${out}`);
  }
}

// Run only when invoked directly (`node scripts/gen-schema.mjs`). Compare real
// paths so a symlinked invocation (bin shim, pnpm link) still matches.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();

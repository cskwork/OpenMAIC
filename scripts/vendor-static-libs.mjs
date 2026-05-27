// scripts/vendor-static-libs.mjs
// Copies KaTeX and Three.js dist files from node_modules into public/vendor/
// so that interactive HTML scenes can reference them via /vendor/... URLs
// instead of jsdelivr/unpkg. Runs as a postinstall step.

import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const vendorDir = resolve(root, 'public/vendor');

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  if (!(await exists(src))) {
    throw new Error(`Source not found: ${src}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
}

async function main() {
  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });

  // KaTeX: copy entire dist/ (CSS, JS, fonts, contrib/)
  await copyDir(resolve(root, 'node_modules/katex/dist'), resolve(vendorDir, 'katex'));

  // Three.js: copy build/ (three.module.js + maps) and examples/jsm/ (addons)
  await copyDir(resolve(root, 'node_modules/three/build'), resolve(vendorDir, 'three/build'));
  await copyDir(
    resolve(root, 'node_modules/three/examples/jsm'),
    resolve(vendorDir, 'three/examples/jsm'),
  );

  console.log('✓ Vendored KaTeX + Three.js to public/vendor/');
}

main().catch((err) => {
  console.error('✗ vendor-static-libs failed:', err);
  process.exit(1);
});

/**
 * unzip — expand the app's export ZIP into a project directory the producer can
 * render. The archive layout is exactly what `packageVideoZip` produces:
 * `index.html` + `assets/**` + the vendored GSAP, all project-relative.
 *
 * Uses fflate's synchronous `unzipSync` (the archives are tens of MB of already
 * PNG/audio-compressed bytes, so streaming buys little) and writes each entry
 * under `destDir`, guarding against path traversal (`../`) in entry names.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';

export class InvalidProjectError extends Error {}

/**
 * Expand `zip` into `destDir`. Returns nothing; throws {@link InvalidProjectError}
 * if the archive escapes `destDir` or lacks an `index.html` entry.
 */
export async function unzipProject(zip: Uint8Array, destDir: string): Promise<void> {
  const entries = unzipSync(zip);
  const names = Object.keys(entries);
  if (!names.some((n) => n === 'index.html' || n.endsWith('/index.html'))) {
    throw new InvalidProjectError('Export archive is missing index.html');
  }

  const destRoot = resolve(destDir);
  for (const [name, bytes] of Object.entries(entries)) {
    // Directory entries in a zip end with '/'.
    if (name.endsWith('/')) continue;

    const target = resolve(destRoot, name);
    const rel = relative(destRoot, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new InvalidProjectError(`Unsafe path in archive: ${name}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

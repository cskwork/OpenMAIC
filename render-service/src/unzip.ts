/**
 * unzip — expand the app's export ZIP into a project directory the producer can
 * render. The archive layout is exactly what `packageVideoZip` produces:
 * `index.html` + `assets/**` + the vendored GSAP, all project-relative.
 *
 * The archive is untrusted input, so extraction is bounded *before* any bytes
 * are decompressed: fflate's `filter` runs per entry with the entry's declared
 * compressed (`size`) and expanded (`originalSize`) sizes, letting us reject
 * ZIP bombs (too many entries, an oversized entry, oversized total, or an
 * implausible compression ratio) without ever materializing them. Path
 * traversal (`../`) is rejected too.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { unzipSync } from 'fflate';
import { config } from './config.js';

export class InvalidProjectError extends Error {}

/**
 * Expand `zip` into `destDir`. Throws {@link InvalidProjectError} if the archive
 * escapes `destDir`, trips a size/entry limit, or lacks an `index.html` entry.
 */
export async function unzipProject(zip: Uint8Array, destDir: string): Promise<void> {
  let entryCount = 0;
  let expandedTotal = 0;

  // The filter is the security boundary: it runs for every entry using only the
  // ZIP's declared sizes, before fflate decompresses anything. Throwing here
  // aborts the whole `unzipSync` call. Directory entries carry no data.
  const entries = unzipSync(zip, {
    filter: (file) => {
      if (file.name.endsWith('/')) return false;

      entryCount += 1;
      if (entryCount > config.maxEntries) {
        throw new InvalidProjectError(`Archive has too many entries (> ${config.maxEntries})`);
      }
      if (file.originalSize > config.maxEntryBytes) {
        throw new InvalidProjectError(`Archive entry too large: ${file.name}`);
      }
      // Ratio guard catches deeply-compressed bombs (a tiny entry claiming a
      // huge expansion). Ignore tiny entries where the ratio is meaningless.
      if (file.size > 0 && file.originalSize / file.size > config.maxCompressionRatio) {
        throw new InvalidProjectError(`Archive entry compression ratio too high: ${file.name}`);
      }
      expandedTotal += file.originalSize;
      if (expandedTotal > config.maxExpandedBytes) {
        throw new InvalidProjectError('Archive expands beyond the allowed total size');
      }
      return true;
    },
  });

  const names = Object.keys(entries);
  if (!names.some((n) => n === 'index.html' || n.endsWith('/index.html'))) {
    throw new InvalidProjectError('Export archive is missing index.html');
  }

  const destRoot = resolve(destDir);
  for (const [name, bytes] of Object.entries(entries)) {
    const target = resolve(destRoot, name);
    const rel = relative(destRoot, target);
    if (rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
      throw new InvalidProjectError(`Unsafe path in archive: ${name}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

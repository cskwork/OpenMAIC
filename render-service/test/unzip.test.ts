/**
 * Security-boundary tests for archive extraction: the ZIP is untrusted input,
 * so `unzipProject` must reject bombs (entry count / entry size / total size /
 * compression ratio) *before* decompressing, reject path traversal, and require
 * an `index.html`. These are the guards standing between a hostile upload and
 * the render host.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { unzipProject, InvalidProjectError } from '../src/unzip.js';

let dest: string;

beforeEach(async () => {
  dest = await mkdtemp(join(tmpdir(), 'unzip-test-'));
});
afterEach(async () => {
  await rm(dest, { recursive: true, force: true });
});

/** Build a ZIP from a name→string map with no per-file compression tuning. */
function zip(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) entries[name] = strToU8(content);
  return zipSync(entries);
}

describe('unzipProject', () => {
  it('extracts a valid project with index.html', async () => {
    const archive = zip({ 'index.html': '<!doctype html>', 'assets/app.js': 'console.log(1)' });
    await unzipProject(archive, dest);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toContain('<!doctype html>');
    expect(await readFile(join(dest, 'assets/app.js'), 'utf8')).toContain('console.log');
  });

  it('rejects an archive missing index.html', async () => {
    const archive = zip({ 'assets/app.js': 'x' });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects path traversal outside the destination', async () => {
    // fflate preserves the literal entry name; a `../` escape must be caught.
    const archive = zipSync({
      'index.html': strToU8('<!doctype html>'),
      '../escape.txt': strToU8('pwned'),
    });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
    await expect(readFile(join(dest, '..', 'escape.txt'), 'utf8')).rejects.toBeTruthy();
  });

  it('rejects too many entries', async () => {
    const files: Record<string, string> = { 'index.html': '<!doctype html>' };
    // Default RENDER_MAX_ENTRIES is 5000; exceed it.
    for (let i = 0; i < 5001; i++) files[`f${i}.txt`] = 'x';
    await expect(unzipProject(zip(files), dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects a single entry that expands beyond the per-entry cap', async () => {
    // RENDER_MAX_ENTRY_BYTES defaults to 200MB; a >200MB entry trips it. The
    // filter reads the declared originalSize, so we don't need the bytes to be
    // incompressible — but we do need fflate to record a large originalSize, so
    // build a genuinely large (highly compressible) payload.
    const big = 'a'.repeat(210 * 1024 * 1024);
    const archive = zip({ 'index.html': '<!doctype html>', 'big.txt': big });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });

  it('rejects an implausible compression ratio (zip bomb)', async () => {
    // Highly repetitive content compresses far past the 200:1 default ratio.
    const bomb = 'a'.repeat(50 * 1024 * 1024); // ~50MB expands from a tiny deflate stream
    const archive = zip({ 'index.html': '<!doctype html>', 'bomb.txt': bomb });
    await expect(unzipProject(archive, dest)).rejects.toBeInstanceOf(InvalidProjectError);
  });
});

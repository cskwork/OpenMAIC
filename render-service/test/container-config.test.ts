import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('render-service container contract', () => {
  it('resets HOME and the cache root before dropping privileges', () => {
    const entrypoint = read('docker-entrypoint.sh');
    expect(entrypoint).toContain('export HOME="${RENDER_HOME:-/app}"');
    expect(entrypoint).toContain('export XDG_CACHE_HOME="$HOME/.cache"');

    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('HOME=/app');
    expect(dockerfile).toContain('XDG_CACHE_HOME=/app/.cache');
    expect(dockerfile).toMatch(/mkdir -p \/tmp\/openmaic-renders \/app\/\.cache/);
  });

  it('uses a resource-consistent single-job latency profile in Compose', () => {
    const compose = read('../docker-compose.yml');
    expect(compose).toContain('RENDER_MAX_CONCURRENCY=1');
    expect(compose).toContain('RENDER_MAX_CONCURRENT_EXTRACTIONS=1');
    expect(compose).toContain('PRODUCER_LOW_MEMORY_MODE=false');
    expect(compose).toContain('PRODUCER_BROWSER_GPU_MODE=hardware');
    expect(compose).toContain('PRODUCER_ENABLE_BROWSER_POOL=false');
    expect(compose).toContain('PRODUCER_MAX_WORKERS=4');
    expect(compose).toContain('PRODUCER_PUPPETEER_PROTOCOL_TIMEOUT_MS=900000');
    expect(compose).toContain('HF_STATIC_DEDUP=false');
    expect(compose).toContain('mem_limit: 4g');
  });
});

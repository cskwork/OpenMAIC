import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Resolve `@openmaic/choreography` self-imports and the `@openmaic/dsl` dependency
// to their package sources, so `pnpm test` is standalone on a clean checkout (no
// `dist` build required). Consumers still resolve via each package's `exports`
// map → `dist` as before.
export default defineConfig({
  resolve: {
    alias: {
      '@openmaic/choreography': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      '@openmaic/dsl': fileURLToPath(new URL('../dsl/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});

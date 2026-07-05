import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Third-party / vendored packages (not our code):
    'packages/docs/**',
    'packages/mathml2omml/**',
    'packages/pptxgenjs/**',
    // Our own @openmaic/* packages: lint the source, but skip build output,
    // installed deps, and the vendored JS sources under importer/src1.
    'packages/@openmaic/*/dist/**',
    'packages/@openmaic/*/node_modules/**',
    'packages/@openmaic/importer/src1/**',
    // Generated importer bundle copied into public/ by the sync script (postinstall):
    'public/vendor/**',
    // Claude Code local files:
    '.claude/**',
    '.superpowers/**',
    '.worktrees/**',
    // Playwright e2e tests (not React code):
    'e2e/**',
  ]),
  {
    rules: {
      // Dynamic AI-generated image URLs from various providers are incompatible
      // with next/image (requires known dimensions and whitelisted domains).
      '@next/next/no-img-element': 'off',
      // Allow unused vars/args prefixed with _ (common convention for intentionally
      // unused destructured values, callback params, etc.)
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
  // Package boundary (machine-enforced): @openmaic/renderer is a standalone,
  // app-agnostic package. It must never reach back into the host app through
  // the `@/…` path alias, so a deadline can't punch a "temporary"
  // store/undo/media dependency through the package API. Host concerns
  // (document + undo ownership, media resolution, i18n, hotkeys) are injected
  // via props/callbacks instead.
  //
  // Coverage: `no-restricted-imports` handles static `import` / `export … from`
  // (including `import type`) with an import-specific message; `no-restricted-syntax`
  // then matches any `@/…` string the package authors, which covers dynamic
  // import()/require()/require.resolve() in any quote style and string-concatenation
  // operands. Relative parent escapes (`../../app`) are outside this alias rule's
  // scope; the package's own standalone `tsc` (rootDir: src) rejects those at build time.
  {
    files: ['packages/@openmaic/renderer/**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/*', '@/**'],
              message:
                '@openmaic/renderer must not import from the host app (@/…). Depend only on @openmaic/dsl and declared peers; inject host concerns (stores, undo, media resolution, i18n, hotkeys) via props/callbacks.',
            },
          ],
        },
      ],
      // Cover every statically-analyzable `@/…` dynamic form: string-literal and
      // template-literal sources, for `import()`, `require()` and `require.resolve()`.
      // (Genuinely computed sources like `import(someVar)` are undecidable by lint
      // and out of scope for any rule — the boundary catches all static forms.)
      // Everything the import rule can't see: match the `@/…` string prefix
      // wherever it is authored, rather than chasing individual call shapes.
      // This covers dynamic `import()` / `require()` / `require.resolve()` in any
      // quote style AND string-concatenation operands (`'@/lib/' + x` — the
      // `'@/lib/'` literal is itself flagged). The package has zero legitimate
      // `@/…` strings, so there are no false positives. The only residual is a
      // specifier assembled entirely from non-`@/` pieces (`'@' + '/x'`, or a
      // variable) — undecidable by any lint rule and reachable only by deliberate
      // evasion, which `eslint-disable` allows anyway; the package's standalone
      // build is the backstop there.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…) — this also covers dynamic import()/require()/require.resolve() and string-concatenation operands, not only static imports. Inject host concerns via props/callbacks.',
        },
        {
          selector: 'TemplateElement[value.cooked=/^@\\//]',
          message:
            '@openmaic/renderer must not reference a host-app path (@/…) in a template literal. Inject host concerns via props/callbacks.',
        },
      ],
    },
  },
]);

export default eslintConfig;

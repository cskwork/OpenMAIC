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
  // Scope: reject *app imports* via the `@/…` alias — precisely, in import
  // contexts only, so a legitimate `@/…` string that is not an import is not a
  // false positive.
  //
  // - `no-restricted-imports` covers static `import` / `export … from`
  //   (including `import type`).
  // - `no-restricted-syntax` covers the dynamic call forms the base rule can't
  //   see — `import()`, `require()`, `require.resolve()` — on single string- or
  //   template-literal specifiers.
  //
  // Deliberately out of scope (not decidable by lint, and evasion-only): a
  // specifier assembled from non-literal parts — `import('@/lib/' + x)`,
  // `import(dynamicVar)`, an aliased `require` — and relative parent escapes
  // (`../../app`). These are caught by building/publishing the package in
  // isolation (only `@openmaic/dsl` + declared peers external), not by this rule.
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
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression[source.value=/^@\\//]',
          message:
            '@openmaic/renderer must not dynamically import from the host app (@/…). Inject host concerns via props/callbacks.',
        },
        {
          selector: 'ImportExpression[source.quasis.0.value.cooked=/^@\\//]',
          message:
            '@openmaic/renderer must not dynamically import from the host app (@/…). Inject host concerns via props/callbacks.',
        },
        {
          selector: "CallExpression[callee.name='require'][arguments.0.value=/^@\\//]",
          message:
            '@openmaic/renderer must not require() from the host app (@/…). Inject host concerns via props/callbacks.',
        },
        {
          selector:
            "CallExpression[callee.name='require'][arguments.0.quasis.0.value.cooked=/^@\\//]",
          message:
            '@openmaic/renderer must not require() from the host app (@/…). Inject host concerns via props/callbacks.',
        },
        {
          selector:
            "CallExpression[callee.object.name='require'][callee.property.name='resolve'][arguments.0.value=/^@\\//]",
          message:
            '@openmaic/renderer must not require.resolve() a host-app path (@/…). Inject host concerns via props/callbacks.',
        },
        {
          selector:
            "CallExpression[callee.object.name='require'][callee.property.name='resolve'][arguments.0.quasis.0.value.cooked=/^@\\//]",
          message:
            '@openmaic/renderer must not require.resolve() a host-app path (@/…). Inject host concerns via props/callbacks.',
        },
      ],
    },
  },
]);

export default eslintConfig;

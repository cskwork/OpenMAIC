import { readFileSync } from 'node:fs';

/**
 * Assert, from vitest's own machine-readable results, that the PostgreSQL
 * contract suites actually ran and actually passed.
 *
 * @openmaic/storage's PostgreSQL backend is the one whose behaviour only a real
 * database can confirm, and the two suites that confirm it refuse to skip when
 * STORAGE_PG_CONTRACT_REQUIRED=1. That refusal is a `throw` at the top of each
 * test module, which can only fire if the module is loaded — and what decides
 * whether it is loaded is `vitest.config.ts`, which no publishable-input rule
 * covers because it never reaches the tarball. Narrowing `include` to exclude
 * `*.pg.test.ts` would therefore have turned both suites off silently, with a
 * green release.
 *
 * So the assertion lives outside the tests: these file names must appear in the
 * results, with passing assertions and none pending.
 */

const REQUIRED_SUITES = [
  'packages/@openmaic/storage/test/pg-document-store.pg.test.ts',
  'packages/@openmaic/storage/test/pg-runtime-store.pg.test.ts',
];

const [resultsPath] = process.argv.slice(2);
if (!resultsPath) {
  console.error('Usage: assert-pg-contract-suites.mjs <vitest-json-results>');
  process.exit(2);
}

let results;
try {
  results = JSON.parse(readFileSync(resultsPath, 'utf8'));
} catch (error) {
  console.error(`Cannot read the vitest results at ${resultsPath}: ${error.message}`);
  process.exit(2);
}

const files = Array.isArray(results.testResults) ? results.testResults : undefined;
if (!files) {
  console.error(
    `${resultsPath} has no testResults array, so it cannot show which suites ran. ` +
      'Was the run invoked with --reporter=json?',
  );
  process.exit(2);
}

const failures = [];
for (const suite of REQUIRED_SUITES) {
  // The reporter records absolute paths; match on the repository-relative tail.
  const entry = files.find((file) => typeof file.name === 'string' && file.name.endsWith(suite));
  if (!entry) {
    failures.push(
      `${suite} did not run. The PostgreSQL contract is unverified, so this release cannot go out. ` +
        "Check vitest's `include`/`exclude` in packages/@openmaic/storage/vitest.config.ts.",
    );
    continue;
  }
  const assertions = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
  const passed = assertions.filter((assertion) => assertion.status === 'passed').length;
  const pending = assertions.filter((assertion) => assertion.status !== 'passed');
  if (entry.status !== 'passed') {
    failures.push(`${suite} reported status "${entry.status}".`);
    continue;
  }
  if (passed === 0) {
    failures.push(`${suite} ran but reported no passing assertions, so it asserted nothing.`);
    continue;
  }
  if (pending.length > 0) {
    failures.push(
      `${suite} left ${pending.length} assertion(s) not passing ` +
        `(${[...new Set(pending.map((assertion) => assertion.status))].join(', ')}).`,
    );
    continue;
  }
  console.log(`${suite}: ${passed} assertions passed.`);
}

if (failures.length > 0) {
  console.error(
    [
      'The PostgreSQL contract suites did not verify the backend:',
      ...failures.map((f) => `- ${f}`),
    ].join('\n'),
  );
  process.exit(1);
}
console.log('Both PostgreSQL contract suites ran against a real database and passed.');

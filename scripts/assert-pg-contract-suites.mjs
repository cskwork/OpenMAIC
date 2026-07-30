import { readFileSync } from 'node:fs';

/**
 * Assert, from vitest's own machine-readable results, that @openmaic/storage's
 * PostgreSQL contract suites actually ran and actually passed.
 *
 * The PostgreSQL backend is the one whose behaviour only a real database can
 * confirm. The two suites that confirm it already refuse to skip when
 * STORAGE_PG_CONTRACT_REQUIRED=1 — but that refusal is a `throw` at the top of
 * each test module, so it can only fire if the module is loaded, and what
 * decides whether it is loaded is `packages/@openmaic/storage/vitest.config.ts`.
 * That file is on the ignore list of publishable inputs (it never reaches the
 * tarball), so narrowing its `include`, or adding an `exclude` for
 * `*.pg.test.ts`, turns both suites off with a green test run, a green version
 * check and no version bump required.
 *
 * The assertion therefore has to live outside the tests: these file names must
 * appear in the results, with passing assertions and none left pending. It
 * keys on the file names rather than on a total count, because a count moves
 * every time an unrelated test is added or removed.
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
      'Was the run invoked with the json reporter?',
  );
  process.exit(2);
}

const failures = [];
for (const suite of REQUIRED_SUITES) {
  // The reporter records absolute paths; match on the repository-relative tail.
  const entry = files.find((file) => typeof file.name === 'string' && file.name.endsWith(suite));
  if (!entry) {
    failures.push(
      `${suite} did not run, so the PostgreSQL contract is unverified. ` +
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
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}
console.log('Both PostgreSQL contract suites ran against a real database and passed.');

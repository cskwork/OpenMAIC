import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

/**
 * Assert that @openmaic/storage's PostgreSQL contract suites really exercised a
 * real PostgreSQL, from evidence that cannot be produced by editing the tests.
 *
 * WHY THIS EXISTS AT ALL. The suites already refuse to skip when
 * STORAGE_PG_CONTRACT_REQUIRED=1, but that refusal is a `throw` inside the test
 * modules, so it cannot fire if vitest stops collecting them. Collection is
 * decided by `packages/@openmaic/storage/vitest.config.ts`, and both that file
 * and the whole `test/` directory are on the ignore list of publishable inputs
 * in `check-package-version-bumps.mjs`. The entire surface those suites live on
 * can therefore be rewritten with no version bump and no release gate noticing.
 *
 * WHY THE VITEST RESULTS ARE NOT ENOUGH ON THEIR OWN. `assertionResults` are
 * test CASES, not `expect()` calls, so a file named `pg-document-store.pg.test.ts`
 * containing nothing but `test('x', () => {})` satisfies every check in phase 1
 * below. And because `test/setup.ts` is already wired as `setupFiles`, a single
 * `vi.mock('pg', ...)` there makes both suites collect, run and pass green
 * against an in-memory fake. Both edits are one line, in `test/`, and need no
 * version bump. Phase 1 therefore proves only that two files with those names
 * ran and reported passing cases — nothing whatsoever about a database.
 *
 * WHAT MAKES THE CLAIM TRUE. Phase 2 connects to the contract database from
 * OUTSIDE the vitest process and asks PostgreSQL itself what happened: the five
 * tables these two backends own must exist, and each must show inserts in
 * `pg_stat_user_tables`. Nothing inside `test/` can forge that, because
 * producing it requires actually writing to the database this script
 * independently connects to.
 *
 * Cumulative insert counters are the right evidence rather than surviving rows:
 * the suites clean up after themselves, so counting rows would prove nothing,
 * while `n_tup_ins` records every insert since the last stats reset and
 * survives that cleanup.
 */

const REQUIRED_SUITES = [
  'packages/@openmaic/storage/test/pg-document-store.pg.test.ts',
  'packages/@openmaic/storage/test/pg-runtime-store.pg.test.ts',
];

/**
 * The tables created by `DOCUMENT_PG_SCHEMA` and `RUNTIME_PG_SCHEMA`. Kept
 * explicit rather than parsed out of those sources: this list is the
 * independent statement of what the contract must have touched, and deriving it
 * from the code under test would let that code narrow its own audit.
 */
const REQUIRED_TABLES = [
  'document_stages',
  'document_scenes',
  'document_outlines',
  'runtime_sessions',
  'runtime_records',
];

const [resultsPath] = process.argv.slice(2);
if (!resultsPath) {
  console.error('Usage: assert-pg-contract-suites.mjs <vitest-json-results>');
  process.exit(2);
}

const contractUrl = process.env.PG_CONTRACT_URL;
if (!contractUrl) {
  console.error(
    'PG_CONTRACT_URL is unset, so there is no database to audit and this check cannot ' +
      'establish that the PostgreSQL contract ran. Invoke it in the same job, with the ' +
      'same PG_CONTRACT_URL, as the vitest run it is auditing.',
  );
  process.exit(2);
}

// Phase 1 --------------------------------------------------------------------
// The two suite files were collected and reported passing cases.

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
  const cases = Array.isArray(entry.assertionResults) ? entry.assertionResults : [];
  const passed = cases.filter((testCase) => testCase.status === 'passed').length;
  const pending = cases.filter((testCase) => testCase.status !== 'passed');
  if (entry.status !== 'passed') {
    failures.push(`${suite} reported status "${entry.status}".`);
    continue;
  }
  if (passed === 0) {
    failures.push(`${suite} ran but reported no passing test cases, so it asserted nothing.`);
    continue;
  }
  if (pending.length > 0) {
    failures.push(
      `${suite} left ${pending.length} test case(s) not passing ` +
        `(${[...new Set(pending.map((testCase) => testCase.status))].join(', ')}).`,
    );
    continue;
  }
  console.log(`${suite}: ${passed} test cases ran and passed.`);
}

if (failures.length > 0) {
  console.error(
    [
      'The PostgreSQL contract suites did not run as required:',
      ...failures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

// Phase 2 --------------------------------------------------------------------
// PostgreSQL's own account of what those suites did to it.

// `pg` is a devDependency of @openmaic/storage, not of the repository root, so
// resolve it from the package that owns it rather than assuming hoisting.
const requireFromStorage = createRequire(
  new URL('../packages/@openmaic/storage/package.json', import.meta.url),
);
const { Client } = requireFromStorage('pg');

async function collectInsertCounts(client) {
  const { rows } = await client.query(
    `SELECT t.relname AS table_name,
            to_regclass('public.' || t.relname) IS NOT NULL AS present,
            COALESCE(s.n_tup_ins, 0)::bigint AS inserts
       FROM unnest($1::text[]) AS t(relname)
       LEFT JOIN pg_stat_user_tables s
              ON s.schemaname = 'public' AND s.relname = t.relname`,
    [REQUIRED_TABLES],
  );
  return new Map(
    rows.map((row) => [row.table_name, { present: row.present, inserts: Number(row.inserts) }]),
  );
}

const client = new Client({ connectionString: contractUrl });
let counts;
try {
  await client.connect();
  // Backends flush statistics at transaction end and on exit, so by the time
  // vitest has returned they are normally already visible. Re-read a few times
  // anyway rather than racing a slow flush, discarding the per-session snapshot
  // each round because a backend caches it.
  for (let attempt = 1; ; attempt += 1) {
    counts = await collectInsertCounts(client);
    const unproven = REQUIRED_TABLES.filter((table) => !(counts.get(table)?.inserts > 0));
    if (unproven.length === 0 || attempt === 5) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
    await client.query('SELECT pg_stat_clear_snapshot()');
  }
} catch (error) {
  console.error(
    `Cannot audit the contract database at PG_CONTRACT_URL: ${error.message}. ` +
      'Without it there is no evidence the suites touched a real PostgreSQL.',
  );
  await client.end().catch(() => {});
  process.exit(2);
}
await client.end().catch(() => {});

const databaseFailures = [];
for (const table of REQUIRED_TABLES) {
  const observed = counts.get(table);
  if (!observed?.present) {
    databaseFailures.push(
      `${table} does not exist in the contract database, so the suites never created it ` +
        'and did not run against this PostgreSQL.',
    );
    continue;
  }
  if (!(observed.inserts > 0)) {
    databaseFailures.push(
      `${table} exists but PostgreSQL recorded no inserts into it, so the suites did not ` +
        'write to this database. Check for a mocked driver in ' +
        'packages/@openmaic/storage/test/setup.ts, or a stubbed-out suite body.',
    );
    continue;
  }
  console.log(`${table}: PostgreSQL recorded ${observed.inserts} inserts.`);
}

if (databaseFailures.length > 0) {
  console.error(
    [
      'The contract database shows no evidence that the PostgreSQL backends were exercised:',
      ...databaseFailures.map((failure) => `- ${failure}`),
    ].join('\n'),
  );
  process.exit(1);
}

console.log(
  `Both PostgreSQL contract suite files ran and passed, and all ${REQUIRED_TABLES.length} tables ` +
    'the two backends own show inserts recorded by the contract database itself.',
);

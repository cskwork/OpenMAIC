import { describe, expect, it } from 'vitest';

import { AGENT_SESSION_PG_SCHEMA, ensureAgentSessionSchema } from '../src/agent-session/pg.js';
import { DOCUMENT_PG_SCHEMA, ensureDocumentSchema } from '../src/document/pg.js';
import { RUNTIME_PG_SCHEMA, ensureSchema } from '../src/runtime/pg.js';
import { USER_SKILL_PG_SCHEMA, ensureUserSkillSchema } from '../src/skill/pg.js';
import {
  AGENT_SESSION_MATERIAL_PG_SCHEMA,
  ensureAgentSessionMaterialSchema,
} from '../src/material/pg.js';
import type { Queryable } from '../src/runtime/pg.js';

/**
 * Golden pins for the two PostgreSQL schemas this package exports.
 *
 * Both constants are public API. A deployment that provisions these tables with
 * its own migration tooling — rather than by calling `ensureDocumentSchema()` /
 * `ensureSchema()` — has to reproduce this DDL exactly for the ensure functions
 * to stay the intended no-op against an already-provisioned database.
 *
 * That coupling is invisible at runtime: every statement here is guarded by
 * `IF NOT EXISTS`, so PostgreSQL silently accepts whatever table already exists
 * under the name. A column type, a nullability, an index, or a FK action can
 * drift apart from a downstream migration without a single error being raised;
 * the first symptom is a store query failing in production, or — worse —
 * succeeding against the wrong types.
 *
 * These tests do not judge whether the DDL is correct. They make changing it
 * impossible to do by accident: any edit fails here and has to be made
 * deliberately, in the same change that tells consumers to migrate.
 *
 * Pinning the constants alone would leave a gap, because what a consumer has to
 * reproduce is not the constant but the statements the ensure functions run. So
 * each ensure function is also executed against a recording queryable and its
 * exact statement sequence is asserted, which keeps the two from drifting apart
 * through a change that touches only the function.
 */

const EXPECTED_DOCUMENT_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS document_folders (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, normalized_name)
);

CREATE TABLE IF NOT EXISTS document_stages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  interactive_mode BOOLEAN,
  task_engine_mode BOOLEAN,
  created_at DOUBLE PRECISION NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL,
  owner_id TEXT,
  folder_id TEXT,
  data JSONB NOT NULL
);

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS owner_id TEXT;

ALTER TABLE document_stages
  ADD COLUMN IF NOT EXISTS folder_id TEXT;

CREATE INDEX IF NOT EXISTS document_stages_owner_idx
  ON document_stages (owner_id, id) WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS document_stages_owner_folder_idx
  ON document_stages (owner_id, folder_id, id)
  WHERE owner_id IS NOT NULL AND folder_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS document_scenes (
  stage_id TEXT NOT NULL REFERENCES document_stages(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  scene_order DOUBLE PRECISION NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (stage_id, id)
);

CREATE INDEX IF NOT EXISTS document_scenes_stage_order_idx
  ON document_scenes (stage_id, scene_order, id);

CREATE TABLE IF NOT EXISTS document_outlines (
  stage_id TEXT PRIMARY KEY REFERENCES document_stages(id) ON DELETE CASCADE,
  data JSONB NOT NULL
);
`;

const EXPECTED_RUNTIME_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS runtime_sessions (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL,
  learner_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS runtime_sessions_stage_learner_idx
  ON runtime_sessions (stage_id, learner_key);
CREATE INDEX IF NOT EXISTS runtime_sessions_learner_idx
  ON runtime_sessions (learner_key);

CREATE TABLE IF NOT EXISTS runtime_records (
  id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES runtime_sessions(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq >= 0),
  scene_id TEXT,
  created_at TEXT NOT NULL,
  data JSONB NOT NULL,
  CONSTRAINT runtime_records_session_seq_unique UNIQUE (session_id, seq)
);

CREATE INDEX IF NOT EXISTS runtime_records_session_scene_idx
  ON runtime_records (session_id, scene_id);
`;

const EXPECTED_AGENT_SESSION_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  stage_id            TEXT NOT NULL,
  active_stage_id     TEXT,
  skill_id            TEXT,
  origin              TEXT,
  existing_course     BOOLEAN NOT NULL DEFAULT FALSE,
  status              TEXT NOT NULL DEFAULT 'queued',
  attempt             INTEGER NOT NULL DEFAULT 0,
  lease_worker_id     TEXT,
  lease_worker_pid    INTEGER,
  lease_heartbeat_at  BIGINT,
  cancel_requested_at BIGINT,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ,
  CONSTRAINT agent_sessions_attempt_nonnegative CHECK (attempt >= 0),
  CONSTRAINT agent_sessions_status_known
    CHECK (status IN ('queued','running','succeeded','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS agent_sessions_status_live_idx
  ON agent_sessions (status, created_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS agent_sessions_owner_live_idx
  ON agent_sessions (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_session_events (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         BIGINT NOT NULL,
  attempt    INTEGER NOT NULL,
  type       TEXT NOT NULL,
  data       JSONB,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_events_seq_positive CHECK (seq > 0)
);

CREATE TABLE IF NOT EXISTS agent_session_entries (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  entry_id   TEXT NOT NULL,
  parent_id  TEXT,
  type       TEXT NOT NULL,
  data       JSONB NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  attempt    INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq),
  CONSTRAINT agent_session_entries_entry_id_unique UNIQUE (session_id, entry_id),
  CONSTRAINT agent_session_entries_parent_fk
    FOREIGN KEY (session_id, parent_id)
    REFERENCES agent_session_entries (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS agent_session_entries_type_idx
  ON agent_session_entries (session_id, type, seq);

CREATE TABLE IF NOT EXISTS agent_owner_session_event_counters (
  owner_id TEXT PRIMARY KEY,
  n        BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT agent_owner_session_event_counters_nonnegative CHECK (n >= 0)
);

CREATE TABLE IF NOT EXISTS agent_owner_session_events (
  owner_id   TEXT NOT NULL,
  id         BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  session_id TEXT NOT NULL,
  type       TEXT NOT NULL,
  status     TEXT,
  attempt    INTEGER,
  data       JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  CONSTRAINT agent_owner_session_events_type_known CHECK (type IN
    ('session_created','session_status','session_deleted',
     'session_active_stage','session_cancel_requested')),
  CONSTRAINT agent_owner_session_events_status_known CHECK (status IS NULL OR status IN
    ('queued','running','succeeded','failed','cancelled')),
  CONSTRAINT agent_owner_session_events_attempt_nonnegative
    CHECK (attempt IS NULL OR attempt >= 0)
);

CREATE TABLE IF NOT EXISTS agent_session_urls (
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, url),
  CONSTRAINT agent_session_urls_source_known CHECK (source IN ('user','web_search'))
);

CREATE INDEX IF NOT EXISTS agent_session_urls_session_created_idx
  ON agent_session_urls (session_id, created_at);
`;

const EXPECTED_USER_SKILL_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_user_skill (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT agent_user_skill_version_check CHECK (version = 1),
  CONSTRAINT agent_user_skill_name_check
    CHECK (name ~ '^my-[a-z0-9]+(?:-[a-z0-9]+)*$' AND length(name) <= 64),
  CONSTRAINT agent_user_skill_title_check CHECK (length(title) BETWEEN 1 AND 80),
  CONSTRAINT agent_user_skill_description_check
    CHECK (length(description) BETWEEN 1 AND 500 AND description !~ '[\r\n]'),
  CONSTRAINT agent_user_skill_content_check CHECK (octet_length(content) BETWEEN 1 AND 65536)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_user_skill_owner_name_unique
  ON agent_user_skill (owner_id, name) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_user_skill_owner
  ON agent_user_skill (owner_id, created_at) WHERE deleted_at IS NULL;
`;

const EXPECTED_AGENT_SESSION_MATERIAL_PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_session_materials (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  title         TEXT,
  source_url    TEXT,
  text_asset_id TEXT,
  raw_asset_id  TEXT,
  text_chars    INTEGER NOT NULL DEFAULT 0,
  derived_from  TEXT REFERENCES agent_session_materials(id) ON DELETE CASCADE,
  extraction_status TEXT NOT NULL DEFAULT 'done',
  extraction_attempts INTEGER NOT NULL DEFAULT 0,
  extraction_error TEXT,
  extraction_stats JSONB,
  extractor_version TEXT,
  extraction_lease_worker_id TEXT,
  extraction_lease_worker_pid INTEGER,
  extraction_lease_heartbeat_at BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT agent_session_materials_kind_known CHECK (kind IN
    ('source','extraction','transcript','audio-track','image','web')),
  CONSTRAINT agent_session_materials_text_chars_nonnegative CHECK (text_chars >= 0)
  ,CONSTRAINT agent_session_materials_extraction_status_known CHECK (extraction_status IN
    ('idle','pending','running','done','failed'))
  ,CONSTRAINT agent_session_materials_extraction_attempts_nonnegative CHECK (extraction_attempts >= 0)
);

CREATE INDEX IF NOT EXISTS agent_session_materials_session_created_idx
  ON agent_session_materials (session_id, created_at);

CREATE INDEX IF NOT EXISTS agent_session_materials_extraction_queue_idx
  ON agent_session_materials (created_at)
  WHERE kind = 'source' AND extraction_status IN ('pending','running');
`;

/** Records the statements an ensure function actually issues. */
function recordingQueryable(): { statements: string[]; queryable: Queryable } {
  const statements: string[] = [];
  return {
    statements,
    queryable: {
      async query<TRow extends Record<string, unknown>>(text: string) {
        statements.push(text);
        return { rows: [] as TRow[] };
      },
    },
  };
}

function statementsOf(schema: string): string[] {
  return schema
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '');
}

const schemas = [
  {
    name: 'DOCUMENT_PG_SCHEMA',
    actual: DOCUMENT_PG_SCHEMA,
    expected: EXPECTED_DOCUMENT_PG_SCHEMA,
    ensure: ensureDocumentSchema,
  },
  {
    name: 'RUNTIME_PG_SCHEMA',
    actual: RUNTIME_PG_SCHEMA,
    expected: EXPECTED_RUNTIME_PG_SCHEMA,
    ensure: ensureSchema,
  },
  {
    name: 'AGENT_SESSION_PG_SCHEMA',
    actual: AGENT_SESSION_PG_SCHEMA,
    expected: EXPECTED_AGENT_SESSION_PG_SCHEMA,
    ensure: ensureAgentSessionSchema,
  },
  {
    name: 'USER_SKILL_PG_SCHEMA',
    actual: USER_SKILL_PG_SCHEMA,
    expected: EXPECTED_USER_SKILL_PG_SCHEMA,
    ensure: ensureUserSkillSchema,
  },
  {
    name: 'AGENT_SESSION_MATERIAL_PG_SCHEMA',
    actual: AGENT_SESSION_MATERIAL_PG_SCHEMA,
    expected: EXPECTED_AGENT_SESSION_MATERIAL_PG_SCHEMA,
    ensure: ensureAgentSessionMaterialSchema,
  },
];

describe.each(schemas)('$name is a pinned contract', ({ name, actual, expected, ensure }) => {
  it('is exactly what the ensure function provisions', async () => {
    // Pinning the constant alone would not notice the ensure function growing
    // extra DDL, dropping the index statements, or reordering them. What a
    // consumer has to reproduce is what actually runs, so assert that.
    const { statements, queryable } = recordingQueryable();
    await ensure(queryable);

    expect(statements).toEqual(statementsOf(expected));
  });

  it('provisions idempotently on a second call', async () => {
    const { statements, queryable } = recordingQueryable();
    await ensure(queryable);
    await ensure(queryable);

    const once = statementsOf(expected);
    expect(statements).toEqual([...once, ...once]);
  });

  it('matches the published DDL verbatim', () => {
    // A failure here is not a broken test: it means the schema changed. Update
    // this pin in the same change, and treat it as a breaking change for any
    // deployment that provisions these tables through its own migrations.
    expect(actual).toBe(expected);
  });

  it('keeps every statement guarded so the ensure functions stay idempotent', () => {
    const statements = actual
      .split(';')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(
        /^CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS /.test(statement) ||
          /^ALTER TABLE [a-z_]+\s+ADD COLUMN IF NOT EXISTS /.test(statement),
        `${name} statement is not an idempotent create or additive migration: ${statement}`,
      ).toBe(true);
    }
  });
});

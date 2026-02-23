-- ePoc analytics schema (PostgreSQL)
-- Stores both snapshot and event documents streamed from Sync Gateway.

CREATE TABLE IF NOT EXISTS learning_snapshot (
  snapshot_id   TEXT PRIMARY KEY,
  learner_id    TEXT,
  learner_key   TEXT,
  generated_at  TIMESTAMPTZ,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_snapshot_learner_key ON learning_snapshot (learner_key);
CREATE INDEX IF NOT EXISTS idx_learning_snapshot_generated_at ON learning_snapshot (generated_at);

CREATE TABLE IF NOT EXISTS learning_event (
  event_id     TEXT PRIMARY KEY,
  learner_id   TEXT,
  learner_key  TEXT,
  epoc_id      TEXT,
  event_type   TEXT,
  ts           TIMESTAMPTZ,
  payload      JSONB NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_learning_event_learner_key ON learning_event (learner_key);
CREATE INDEX IF NOT EXISTS idx_learning_event_epoc_id ON learning_event (epoc_id);
CREATE INDEX IF NOT EXISTS idx_learning_event_type_ts ON learning_event (event_type, ts);

-- Convenience view (flat columns for Metabase / pivot-like analysis)
CREATE OR REPLACE VIEW learning_event_flat AS
SELECT
  event_id,
  learner_id,
  learner_key,
  epoc_id,
  event_type,
  ts,
  (payload ->> 'assessmentId')         AS assessment_id,
  (payload ->> 'badgeId')              AS badge_id,
  NULLIF(payload ->> 'score', '')::NUMERIC         AS score,
  NULLIF(payload ->> 'attemptsCount', '')::INT     AS attempts_count,
  NULLIF(payload ->> 'durationSeconds', '')::INT   AS duration_seconds,
  (payload ->> 'route')                AS route,
  payload
FROM learning_event;

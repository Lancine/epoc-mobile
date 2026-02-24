-- Create dedicated DB for Metabase (metadata) + user
CREATE USER metabase WITH PASSWORD 'metabase';
CREATE DATABASE metabase OWNER metabase;

-- Tables for ePoc learning analytics (in POSTGRES_DB = epoc_analytics)

CREATE TABLE IF NOT EXISTS etl_state (
  id INT PRIMARY KEY DEFAULT 1,
  since TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO etl_state (id, since)
VALUES (1, '0')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS learning_snapshot (
  id TEXT PRIMARY KEY,
  learner_key TEXT,
  learner_id TEXT,
  generated_at TIMESTAMPTZ,
  epoc_count INT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS learning_event (
  id TEXT PRIMARY KEY,
  learner_key TEXT,
  learner_id TEXT,
  ts TIMESTAMPTZ,
  event_type TEXT,
  epoc_id TEXT,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW learning_event_flat AS
SELECT
  id,
  learner_key,
  learner_id,
  ts,
  event_type,
  epoc_id,
  payload->>'badgeId' AS badge_id,
  NULLIF(payload->>'score','')::NUMERIC AS score,
  NULLIF(payload->>'attemptsCount','')::INT AS attempts_count,
  NULLIF(payload->>'durationSeconds','')::INT AS duration_seconds,
  payload
FROM learning_event;

import os
import time
import json
from typing import Any, Dict, Optional

import requests
import psycopg2
import psycopg2.extras


def env(name: str, default: str = "") -> str:
  v = os.getenv(name)
  return v if v is not None and v != "" else default


SG_ADMIN_URL = env("SG_ADMIN_URL", "http://sync-gateway:4985").rstrip("/")
SG_DB = env("SG_DB", "epoc-learning").strip("/")
POLL_SECONDS = int(env("POLL_SECONDS", "5"))

PGHOST = env("PGHOST", "postgres")
PGPORT = int(env("PGPORT", "5432"))
PGDATABASE = env("PGDATABASE", "epoc_analytics")
PGUSER = env("PGUSER", "epoc")
PGPASSWORD = env("PGPASSWORD", "epoc")


def pg_connect():
  return psycopg2.connect(
    host=PGHOST,
    port=PGPORT,
    dbname=PGDATABASE,
    user=PGUSER,
    password=PGPASSWORD,
  )


def get_since(conn) -> str:
  with conn.cursor() as cur:
    cur.execute("SELECT since FROM etl_state WHERE id=1")
    row = cur.fetchone()
    return row[0] if row and row[0] else "0"


def set_since(conn, since: str) -> None:
  with conn.cursor() as cur:
    cur.execute(
      "UPDATE etl_state SET since=%s, updated_at=NOW() WHERE id=1",
      (since,),
    )
  conn.commit()


def upsert_snapshot(conn, doc: Dict[str, Any]) -> None:
  payload = doc
  doc_id = payload.get("_id") or payload.get("id")
  learner_key = payload.get("learnerKey")
  learner_id = payload.get("learnerId")
  generated_at = payload.get("generatedAt")
  courses = payload.get("courses") or []
  epoc_count = len(courses) if isinstance(courses, list) else None

  with conn.cursor() as cur:
    cur.execute(
      """
      INSERT INTO learning_snapshot (id, learner_key, learner_id, generated_at, epoc_count, payload)
      VALUES (%s, %s, %s, %s, %s, %s::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        learner_key=EXCLUDED.learner_key,
        learner_id=EXCLUDED.learner_id,
        generated_at=EXCLUDED.generated_at,
        epoc_count=EXCLUDED.epoc_count,
        payload=EXCLUDED.payload,
        received_at=NOW()
      """,
      (doc_id, learner_key, learner_id, generated_at, epoc_count, json.dumps(payload)),
    )
  conn.commit()


def upsert_event(conn, doc: Dict[str, Any]) -> None:
  payload = doc
  doc_id = payload.get("_id") or payload.get("id")
  learner_key = payload.get("learnerKey")
  learner_id = payload.get("learnerId")
  ts = payload.get("ts")
  event_type = payload.get("eventType")
  epoc_id = payload.get("epocId")

  with conn.cursor() as cur:
    cur.execute(
      """
      INSERT INTO learning_event (id, learner_key, learner_id, ts, event_type, epoc_id, payload)
      VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        learner_key=EXCLUDED.learner_key,
        learner_id=EXCLUDED.learner_id,
        ts=EXCLUDED.ts,
        event_type=EXCLUDED.event_type,
        epoc_id=EXCLUDED.epoc_id,
        payload=EXCLUDED.payload,
        received_at=NOW()
      """,
      (doc_id, learner_key, learner_id, ts, event_type, epoc_id, json.dumps(payload)),
    )
  conn.commit()


def fetch_changes(since: str) -> Optional[Dict[str, Any]]:
  url = f"{SG_ADMIN_URL}/{SG_DB}/_changes"
  params = {
    "since": since,
    "limit": 200,
    "include_docs": "true",
    "feed": "normal",
  }
  try:
    r = requests.get(url, params=params, timeout=15)
    if r.status_code != 200:
      print("[etl] sync-gateway error", r.status_code, r.text[:200])
      return None
    return r.json()
  except Exception as e:
    print("[etl] request error", repr(e))
    return None


def main():
  print(f"[etl] start: SG={SG_ADMIN_URL}/{SG_DB} PG={PGHOST}:{PGPORT}/{PGDATABASE}")
  while True:
    try:
      conn = pg_connect()
      break
    except Exception as e:
      print("[etl] waiting for postgres...", repr(e))
      time.sleep(2)

  while True:
    try:
      since = get_since(conn)
      data = fetch_changes(since)
      if not data:
        time.sleep(POLL_SECONDS)
        continue

      results = data.get("results") or []
      for item in results:
        doc = item.get("doc")
        if not isinstance(doc, dict):
          continue

        doc_type = doc.get("type")
        if doc_type == "learningExport":
          upsert_snapshot(conn, doc)
        elif doc_type == "learningEvent":
          upsert_event(conn, doc)

      last_seq = data.get("last_seq")
      if last_seq is not None:
        set_since(conn, str(last_seq))

    except Exception as e:
      print("[etl] loop error", repr(e))
      # reconnect on failures
      try:
        conn.close()
      except Exception:
        pass
      time.sleep(2)
      try:
        conn = pg_connect()
      except Exception:
        conn = None
        while conn is None:
          try:
            conn = pg_connect()
          except Exception as e2:
            print("[etl] waiting for postgres...", repr(e2))
            time.sleep(2)

    time.sleep(POLL_SECONDS)


if __name__ == "__main__":
  main()

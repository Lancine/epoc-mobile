import json
import os
import time
from datetime import datetime
from typing import Any, Dict, Optional

import psycopg2
import requests

SG_ADMIN_DB_URL = os.environ.get("SG_ADMIN_DB_URL", "").rstrip("/")
PG_DSN = os.environ.get("PG_DSN", "")
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
BATCH_LIMIT = int(os.environ.get("BATCH_LIMIT", "500"))

STATE_DIR = os.environ.get("STATE_DIR", "/state")
STATE_FILE = os.path.join(STATE_DIR, "last_seq.txt")

if not SG_ADMIN_DB_URL:
    raise SystemExit("Missing SG_ADMIN_DB_URL (e.g. http://sync-gateway:4985/epoc-learning)")
if not PG_DSN:
    raise SystemExit("Missing PG_DSN (e.g. postgresql://epoc:epoc@postgres:5432/epoc_analytics)")

os.makedirs(STATE_DIR, exist_ok=True)


def load_last_seq() -> str:
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return f.read().strip() or "0"
    except FileNotFoundError:
        return "0"


def save_last_seq(seq: str) -> None:
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        f.write(str(seq))


def parse_ts(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # ISO 8601 with Z
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


SQL_UPSERT_SNAPSHOT = '''
INSERT INTO learning_snapshot (snapshot_id, learner_id, learner_key, generated_at, payload)
VALUES (%s, %s, %s, %s, %s::jsonb)
ON CONFLICT (snapshot_id) DO UPDATE SET
  learner_id = EXCLUDED.learner_id,
  learner_key = EXCLUDED.learner_key,
  generated_at = EXCLUDED.generated_at,
  payload = EXCLUDED.payload,
  received_at = now()
'''

SQL_UPSERT_EVENT = '''
INSERT INTO learning_event (event_id, learner_id, learner_key, epoc_id, event_type, ts, payload)
VALUES (%s, %s, %s, %s, %s, %s, %s::jsonb)
ON CONFLICT (event_id) DO UPDATE SET
  learner_id = EXCLUDED.learner_id,
  learner_key = EXCLUDED.learner_key,
  epoc_id = EXCLUDED.epoc_id,
  event_type = EXCLUDED.event_type,
  ts = EXCLUDED.ts,
  payload = EXCLUDED.payload,
  received_at = now()
'''


def upsert_snapshot(cur, doc: Dict[str, Any]) -> None:
    snapshot_id = str(doc.get("_id") or doc.get("id") or "")
    if not snapshot_id:
        return

    learner_id = doc.get("learnerId")
    learner_key = doc.get("learnerKey")
    generated_at = parse_ts(doc.get("generatedAt"))

    cur.execute(
        SQL_UPSERT_SNAPSHOT,
        (snapshot_id, learner_id, learner_key, generated_at, json.dumps(doc)),
    )


def upsert_event(cur, doc: Dict[str, Any]) -> None:
    event_id = str(doc.get("_id") or doc.get("id") or "")
    if not event_id:
        return

    learner_id = doc.get("learnerId")
    learner_key = doc.get("learnerKey")
    epoc_id = doc.get("epocId")
    event_type = doc.get("eventType")
    ts = parse_ts(doc.get("ts"))

    cur.execute(
        SQL_UPSERT_EVENT,
        (event_id, learner_id, learner_key, epoc_id, event_type, ts, json.dumps(doc)),
    )


def process_doc(cur, doc: Dict[str, Any]) -> None:
    doc_type = doc.get("type")
    if doc_type == "learningExport":
        upsert_snapshot(cur, doc)
    elif doc_type == "learningEvent":
        upsert_event(cur, doc)
    else:
        return


def poll_changes(since: str) -> str:
    url = f"{SG_ADMIN_DB_URL}/_changes"
    params = {
        "since": since,
        "include_docs": "true",
        "limit": str(BATCH_LIMIT),
    }
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()

    results = data.get("results", []) or []
    last_seq = data.get("last_seq", since)

    if not results:
        return str(last_seq)

    with psycopg2.connect(PG_DSN) as conn:
        conn.autocommit = False
        with conn.cursor() as cur:
            for row in results:
                doc = row.get("doc")
                if isinstance(doc, dict):
                    process_doc(cur, doc)
            conn.commit()

    return str(last_seq)


def main() -> None:
    since = load_last_seq()
    print(f"[etl] starting (since={since}) SG={SG_ADMIN_DB_URL}")

    while True:
        try:
            new_since = poll_changes(since)
            if new_since != since:
                since = new_since
                save_last_seq(since)
                print(f"[etl] advanced to since={since}")
        except Exception as e:
            print(f"[etl] error: {e}")

        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()

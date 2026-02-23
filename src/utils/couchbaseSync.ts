/**
 * Couchbase Lite JavaScript sync helper for ePoc-mobile
 *
 * What we want (PRO version):
 * - Keep offline tracking local (Pinia + Ionic Storage)
 * - ALSO persist learning snapshots + events into Couchbase Lite (IndexedDB)
 * - Sync (replicate) to Sync Gateway over WebSockets (ws/wss)
 * - Enforce per-learner isolation on the server (channels + auth)
 *
 * Notes (Couchbase docs):
 * - Couchbase Lite JS is installed as `@couchbase/lite-js` and imported in TS/JS. 
 * - Replication is configured with `url: 'wss://...:4984/<db>'` and a `collections` map, plus `credentials`. 
 *
 * Recommended Vite env vars:
 * - VITE_CBL_SYNC_URL          = wss://<sync-gateway-host>:4984/epoc-learning
 * - VITE_CBL_SYNC_ENABLED      = true|false (optional; default true when URL is set)
 * - VITE_CBL_DB_NAME           = epoc-learning (optional; local db name)
 * - VITE_CBL_SYNC_CONTINUOUS   = true|false (optional; default true)
 *
 * Auth (recommended):
 * - Either set VITE_CBL_SYNC_USERNAME / VITE_CBL_SYNC_PASSWORD (static credentials),
 * - OR use a small "provisioner" service that creates Sync Gateway users and returns credentials:
 *     VITE_CBL_PROVISION_URL = https://<your-domain>/register
 *
 * Identity:
 * - learnerId is the human identifier (phone/matricule) saved in the User profile.
 * - learnerKey is the "sync key" used for channels & usernames (by default: sanitized learnerId).
 *   You can optionally hash it with a public salt using VITE_CBL_LEARNER_KEY_SALT.
 */

import { Database, Replicator } from '@couchbase/lite-js';

import { useStorage } from '@/composables/useStorage';
import { useUser } from '@/composables/useUser';

export type CouchbaseSyncConfig = {
  enabled: boolean;
  dbName: string; // local database name
  url?: string; // ws(s)://host:4984/<db>
  continuous: boolean;

  // Optional direct Basic Auth credentials
  username?: string;
  password?: string;

  // Optional provisioning endpoint
  provisionUrl?: string;

  // Optional: deterministic learnerKey hashing (privacy)
  learnerKeySalt?: string;
};

export type CblCredentials = {
  learnerId: string;
  learnerKey: string; // also used as Sync Gateway username in the default setup
  username: string;
  password: string;
  issuedAt: string;
};

export type LearningEventInput = {
  eventType: string; // e.g. "badge_unlocked", "assessment_attempt", "session_end"
  ts?: string; // ISO timestamp (defaults to now)
  epocId?: string;
  payload?: Record<string, any>;
  // Optional stable key to dedupe (if you can provide one)
  eventKey?: string;
};

let db: any | null = null;
let replicator: any | null = null;
let replicatorStarted = false;
let initPromise: Promise<void> | null = null;
let lastReplicatorStatus: any | null = null;

// Cached identity/credentials (resolved at runtime)
let cachedLearnerId: string | null = null;
let cachedLearnerKey: string | null = null;
let cachedCreds: CblCredentials | null = null;

// Storage key for persisted credentials
const CREDS_STORAGE_KEY = 'cbl.credentials.v1';

function truthyEnv(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  const v = String(value).trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'true', 'yes', 'y', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(v)) return false;
  return undefined;
}

function sanitizeIdPart(value: string): string {
  // Keep doc IDs URL-safe and Sync Gateway friendly
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._:-]/g, '_')
    .slice(0, 120);
}

function isoToDocSafe(ts: string): string {
  // 2026-02-23T12:34:56.789Z -> 2026-02-23T12-34-56-789Z
  return ts.replace(/[:.]/g, '-');
}

async function sha256Base64Url(input: string): Promise<string> {
  // Browser / WebView crypto
  const cryptoObj: any = (globalThis as any).crypto;
  if (!cryptoObj?.subtle) {
    // Fallback (no crypto): just sanitize
    return sanitizeIdPart(input);
  }

  const enc = new TextEncoder();
  const data = enc.encode(input);
  const hashBuf = await cryptoObj.subtle.digest('SHA-256', data);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  const b64 = btoa(String.fromCharCode(...hashArr));
  // base64url
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function getCouchbaseSyncConfig(): CouchbaseSyncConfig {
  const env = import.meta.env as any;

  const url = (env.VITE_CBL_SYNC_URL as string | undefined)?.trim();
  const enabledFlag = truthyEnv(env.VITE_CBL_SYNC_ENABLED);

  // Default behavior: enable when URL is provided
  const enabled = enabledFlag ?? !!url;

  const dbName = (env.VITE_CBL_DB_NAME as string | undefined)?.trim() || 'epoc-learning';
  const continuous = truthyEnv(env.VITE_CBL_SYNC_CONTINUOUS) ?? true;

  const username = (env.VITE_CBL_SYNC_USERNAME as string | undefined)?.trim() || undefined;
  const passwordRaw = env.VITE_CBL_SYNC_PASSWORD as string | undefined;
  const password = passwordRaw !== undefined && passwordRaw !== '' ? String(passwordRaw) : undefined;

  const provisionUrl = (env.VITE_CBL_PROVISION_URL as string | undefined)?.trim() || undefined;
  const learnerKeySalt = (env.VITE_CBL_LEARNER_KEY_SALT as string | undefined)?.trim() || undefined;

  return {
    enabled,
    dbName,
    url,
    continuous,
    username,
    password,
    provisionUrl,
    learnerKeySalt,
  };
}

export function isCouchbaseSyncEnabled(): boolean {
  const cfg = getCouchbaseSyncConfig();
  return cfg.enabled;
}

export function getLastReplicatorStatus(): any | null {
  return lastReplicatorStatus;
}

function getCollection(): any {
  if (!db) return null;
  // Couchbase Lite JS uses a collections map; we keep everything in _default for simplicity.
  return db.collections?._default ?? db.collections?.['_default'] ?? null;
}

async function ensureDbOpen(): Promise<void> {
  if (db) return;

  const cfg = getCouchbaseSyncConfig();

  db = await Database.open({
    name: cfg.dbName,
    version: 1,
    collections: {
      _default: {
        // Very small client-side indexes to speed up local lookups
        indexes: ['type', 'schema', 'generatedAt', 'learnerKey', 'learnerId', 'eventType', 'ts', 'epocId'],
      },
    },
  });
}

async function resolveIdentity(): Promise<{ learnerId?: string; learnerKey?: string }> {
  if (cachedLearnerId !== null || cachedLearnerKey !== null) {
    return { learnerId: cachedLearnerId ?? undefined, learnerKey: cachedLearnerKey ?? undefined };
  }

  const userService = useUser();
  await userService.fetchUser();
  const user = userService.getUser.value as any;

  const learnerId = String(user?.learnerId ?? '').trim();
  cachedLearnerId = learnerId || '';

  const cfg = getCouchbaseSyncConfig();
  if (!learnerId) {
    cachedLearnerKey = '';
    return { learnerId: learnerId || undefined, learnerKey: undefined };
  }

  if (cfg.learnerKeySalt) {
    // Privacy option: hash(phone + salt) -> short key
    const full = await sha256Base64Url(`${cfg.learnerKeySalt}::${learnerId}`);
    cachedLearnerKey = full.slice(0, 32); // keep it shorter
  } else {
    cachedLearnerKey = sanitizeIdPart(learnerId);
  }

  return { learnerId, learnerKey: cachedLearnerKey || undefined };
}

async function loadStoredCreds(): Promise<CblCredentials | null> {
  try {
    const storage = useStorage();
    const raw = await storage.getValue(CREDS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.username || !parsed?.password || !parsed?.learnerKey) return null;
    return parsed as CblCredentials;
  } catch {
    return null;
  }
}

async function saveStoredCreds(creds: CblCredentials): Promise<void> {
  try {
    const storage = useStorage();
    await storage.setValue(CREDS_STORAGE_KEY, JSON.stringify(creds));
  } catch {
    // ignore
  }
}

async function provisionCredentials(learnerId: string, learnerKey: string, provisionUrl: string): Promise<CblCredentials | null> {
  try {
    const res = await fetch(provisionUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ learnerId, learnerKey }),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as any;

    // Expected minimal response:
    // { username, password } OR { learnerKey, username, password }
    const username = String(data.username ?? learnerKey).trim();
    const password = String(data.password ?? '').trim();
    if (!username || !password) return null;

    const creds: CblCredentials = {
      learnerId,
      learnerKey: String(data.learnerKey ?? learnerKey),
      username,
      password,
      issuedAt: new Date().toISOString(),
    };

    await saveStoredCreds(creds);
    return creds;
  } catch {
    return null;
  }
}

async function ensureCredentials(): Promise<CblCredentials | null> {
  // If we already resolved
  if (cachedCreds) return cachedCreds;

  const cfg = getCouchbaseSyncConfig();

  // 1) Static env credentials
  if (cfg.username && cfg.password) {
    const identity = await resolveIdentity();
    const learnerId = identity.learnerId ?? '';
    const learnerKey = identity.learnerKey ?? cfg.username;

    cachedCreds = {
      learnerId,
      learnerKey,
      username: cfg.username,
      password: cfg.password,
      issuedAt: new Date().toISOString(),
    };

    return cachedCreds;
  }

  // 2) Stored creds
  const stored = await loadStoredCreds();
  if (stored) {
    cachedCreds = stored;
    return cachedCreds;
  }

  // 3) Provisioning service
  if (cfg.provisionUrl) {
    const identity = await resolveIdentity();
    if (identity.learnerId && identity.learnerKey) {
      const provisioned = await provisionCredentials(identity.learnerId, identity.learnerKey, cfg.provisionUrl);
      if (provisioned) {
        cachedCreds = provisioned;
        return cachedCreds;
      }
    }
  }

  return null;
}

async function ensureReplicator(): Promise<void> {
  const cfg = getCouchbaseSyncConfig();
  if (!cfg.enabled || !cfg.url) return;
  if (!db) await ensureDbOpen();

  // If replicator already exists, keep it
  if (replicator) return;

  const creds = await ensureCredentials();
  // If we cannot authenticate yet, do NOT start a replicator that will just fail forever.
  if (!creds?.username || !creds?.password) return;

  const config: any = {
    database: db,
    url: cfg.url,
    collections: {
      _default: {
        // Push & pull (single replicator) is the recommended default in docs. 
        push: {
          filter: (doc: any) => doc?.type === 'learningExport' || doc?.type === 'learningEvent',
        },
        pull: {},
      },
    },
    credentials: { username: creds.username, password: creds.password },
    continuous: cfg.continuous,
  };

  replicator = new Replicator(config);

  replicator.onStatusChange = (status: any) => {
    lastReplicatorStatus = status;
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug('[CBL] status:', status?.status ?? status?.activity, status?.progress, status?.error);
    }
  };
}

async function tryStartReplicator(): Promise<void> {
  if (!replicator || replicatorStarted) return;

  const startFn: (() => Promise<any>) | null =
    typeof replicator.run === 'function'
      ? replicator.run.bind(replicator)
      : typeof replicator.start === 'function'
        ? replicator.start.bind(replicator)
        : null;

  if (!startFn) return;

  try {
    await startFn();
    replicatorStarted = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[CBL] Failed to start replicator:', err);
  }
}

/**
 * Public: init local DB + (if possible) start replication.
 * Safe to call multiple times.
 */
export async function initCouchbaseSync(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const cfg = getCouchbaseSyncConfig();
    if (!cfg.enabled) return;

    await ensureDbOpen();
    // Do NOT throw if credentials not available yet; offline usage must still work.
    await ensureReplicator();
    await tryStartReplicator();
  })();

  return initPromise;
}

/**
 * Public: try again to start replication (useful after the user enters learnerId, or after connectivity returns).
 */
export async function wakeCouchbaseSync(): Promise<void> {
  await initCouchbaseSync();
  // Re-check credentials and build replicator if it didn't exist yet
  await ensureReplicator();
  await tryStartReplicator();
}

/**
 * Exported for other modules: current identity (learnerId + learnerKey).
 * learnerKey is the value that should be used for channels and (by default) usernames.
 */
export async function getCouchbaseIdentity(): Promise<{ learnerId?: string; learnerKey?: string }> {
  return resolveIdentity();
}

function buildSnapshotDocId(learnerKey: string, generatedAt: string): string {
  return ['learningExport', sanitizeIdPart(learnerKey || 'anonymous'), isoToDocSafe(generatedAt)].join('::');
}

function buildEventDocId(learnerKey: string, epocId: string | undefined, eventType: string, ts: string, eventKey?: string): string {
  const parts = [
    'learningEvent',
    sanitizeIdPart(learnerKey || 'anonymous'),
    sanitizeIdPart(epocId || 'global'),
    sanitizeIdPart(eventType || 'event'),
    isoToDocSafe(ts),
  ];
  if (eventKey) parts.push(sanitizeIdPart(eventKey));
  return parts.join('::');
}

/**
 * Save a learning snapshot ("export") document locally (CBL).
 * It will be replicated when Sync Gateway is configured.
 */
export async function saveLearningSnapshotDoc(payload: any): Promise<{ docId: string; learnerKey: string; generatedAt: string }> {
  await initCouchbaseSync();
  await ensureDbOpen();

  const collection = getCollection();
  if (!collection) throw new Error('Couchbase Lite collection not available');

  const identity = await resolveIdentity();
  const learnerId = String(payload?.learnerId ?? identity.learnerId ?? '').trim();
  const learnerKey = String(payload?.learnerKey ?? identity.learnerKey ?? learnerId ?? '').trim() || 'anonymous';

  const generatedAt = payload?.generatedAt ? String(payload.generatedAt) : new Date().toISOString();
  const docId = buildSnapshotDocId(learnerKey, generatedAt);

  const doc = {
    ...payload,
    _id: docId,
    type: 'learningExport',
    schema: payload?.schema ?? 'epoc-mobile.learning-export@1',
    learnerId: learnerId || undefined,
    learnerKey: learnerKey || undefined,
    generatedAt,
  };

  await collection.save(doc);

  // Attempt to start replication if possible
  await wakeCouchbaseSync();

  return { docId, learnerKey, generatedAt };
}

/**
 * Save a single learning event document locally (CBL).
 * Use this for "snapshot + events" mode.
 */
export async function saveLearningEventDoc(input: LearningEventInput): Promise<{ docId: string }> {
  await initCouchbaseSync();
  await ensureDbOpen();

  const collection = getCollection();
  if (!collection) throw new Error('Couchbase Lite collection not available');

  const identity = await resolveIdentity();
  const learnerId = identity.learnerId || '';
  const learnerKey = identity.learnerKey || sanitizeIdPart(learnerId || 'anonymous');

  const ts = input.ts ? String(input.ts) : new Date().toISOString();
  const docId = buildEventDocId(learnerKey, input.epocId, input.eventType, ts, input.eventKey);

  const doc = {
    _id: docId,
    type: 'learningEvent',
    schema: 'epoc-mobile.learning-event@1',
    learnerId: learnerId || undefined,
    learnerKey: learnerKey || undefined,
    epocId: input.epocId || undefined,
    eventType: input.eventType,
    ts,
    payload: input.payload ?? {},
  };

  await collection.save(doc);

  // Attempt to start replication if possible
  await wakeCouchbaseSync();

  return { docId };
}

/**
 * Convenience: "fire-and-forget" event logging (won't throw).
 */
export function logLearningEvent(input: LearningEventInput): void {
  saveLearningEventDoc(input).catch(() => null);
}

/**
 * Clear stored credentials (useful if learner changes phone/ID on the same device).
 */
export async function resetCouchbaseCredentials(): Promise<void> {
  cachedCreds = null;
  try {
    const storage = useStorage();
    // We only rely on setValue for maximum compatibility with the existing useStorage composable.
    await storage.setValue(CREDS_STORAGE_KEY, '');
  } catch {
    // ignore
  }
  // Replicator must be rebuilt with new creds
  replicator = null;
  replicatorStarted = false;
  initPromise = null;
}

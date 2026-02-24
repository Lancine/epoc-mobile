import { App } from '@capacitor/app';
import router from '@/router';
import { logLearningEvent } from '@/utils/couchbaseSync';

/**
 * Lightweight "session de connexion" tracker.
 *
 * Goal:
 * - record app sessions (start/end/duration + last route)
 * - store them as Couchbase "learningEvent" docs (eventType = app_session_end)
 *
 * Notes:
 * - This is intentionally best-effort (fire-and-forget).
 * - On mobile, the most reliable signal is App.appStateChange.
 * - On web, visibilitychange + beforeunload covers most cases.
 */

type AppSession = {
  startIso: string;
  lastRoute?: string;
};

let started = false;
let current: AppSession | null = null;

function nowIso() {
  return new Date().toISOString();
}

function startSession(reason: string) {
  // If we already have an active session, do nothing.
  if (current) return;

  current = {
    startIso: nowIso(),
    lastRoute: router.currentRoute.value?.fullPath,
  };

  // Optional: you can log a "start" event too, but we keep only "end" for low volume.
  // logLearningEvent({ eventType: 'app_session_start', ts: current.startIso, payload: { reason, route: current.lastRoute } });
  void reason; // keep linter happy if reason not used
}

function endSession(reason: string) {
  if (!current) return;

  const endIso = nowIso();
  const durationSeconds = Math.max(
    0,
    Math.round((new Date(endIso).getTime() - new Date(current.startIso).getTime()) / 1000),
  );

  logLearningEvent({
    eventType: 'app_session_end',
    ts: endIso,
    // eventKey = start timestamp => deterministic doc id, idempotent
    eventKey: current.startIso,
    payload: {
      start: current.startIso,
      end: endIso,
      durationSeconds,
      reason,
      route: current.lastRoute,
    },
  });

  current = null;
}

export function initLearningSessionTracker() {
  if (started) return;
  started = true;

  // Start the first session immediately
  startSession('init');

  // Track last route (for the session end payload)
  router.afterEach((to) => {
    if (current) current.lastRoute = to.fullPath;
  });

  // Web: visibility change
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        endSession('visibilitychange');
      } else {
        startSession('visibilitychange');
      }
    });
  }

  // Web: before unload (best effort)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('beforeunload', () => {
      endSession('beforeunload');
    });
  }

  // Capacitor: background/foreground
  try {
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) endSession('appStateChange');
      else startSession('appStateChange');
    });
  } catch {
    // Ignore (plugin not available / running in a pure browser without Capacitor)
  }
}

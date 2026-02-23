import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { registerPlugin } from '@capacitor/core';
import { Device } from '@capacitor/device';

import { useReadingStore } from '@/stores/readingStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUser } from '@/composables/useUser';
import { readEpocContent } from '@/utils/epocService';

import {
  initCouchbaseSync,
  isCouchbaseSyncEnabled,
  saveLearningSnapshotDoc,
  saveLearningEventDoc,
  getCouchbaseIdentity,
  type LearningEventInput,
} from '@/utils/couchbaseSync';

const EXPORT_FOLDER = 'exports';
const EXPORT_VERSION = '1.0.0';

// Keep a stable schema string for downstream processors (ETL, dashboards, etc.)
const EXPORT_SCHEMA = 'epoc-mobile.learning-export@1';

// Separate schema for event documents
const EVENT_SCHEMA = 'epoc-mobile.learning-event@1';

// Check schedule every hour (kept from previous implementation)
const SCHEDULE_CHECK_MS = 60 * 60 * 1000;

type ShareOptions = {
  title?: string;
  text?: string;
  url?: string;
  dialogTitle?: string;
};

// Capacitor Share plugin (kept as custom plugin registration for compatibility)
const Share = registerPlugin<{ share(options: ShareOptions): Promise<void> }>('Share');

let schedulerStarted = false;

function resolveEpocPath(epocId: string) {
  if (epocId.startsWith('local-')) {
    return {
      dir: 'local-epocs',
      id: epocId.replace('local-', ''),
    };
  }
  return { dir: 'epocs', id: epocId };
}

function summarizeAssessments(assessments: any[] = []) {
  return {
    totalAttempts: assessments.reduce((sum, item) => sum + (item.attemptsCount ?? 0), 0),
    attemptedCount: assessments.length,
    items: assessments.map((assessment) => ({
      id: assessment.id,
      score: assessment.score,
      attemptedAt: assessment.attemptedAt,
      attemptsCount: assessment.attemptsCount ?? 0,
    })),
  };
}

type ExportFrequency = 'manual' | 'daily' | 'twiceDaily' | 'weekly' | 'monthly';

function isFrequencyDue(lastExportAt: string | undefined, frequency: ExportFrequency | undefined) {
  if (!frequency || frequency === 'manual') return false;
  if (!lastExportAt) return true;

  const now = Date.now();
  const elapsedMs = now - new Date(lastExportAt).getTime();

  const twiceDailyMs = 12 * 60 * 60 * 1000;
  const dailyMs = 24 * 60 * 60 * 1000;
  const weeklyMs = 7 * dailyMs;
  const monthlyMs = 30 * dailyMs;

  switch (frequency) {
    case 'twiceDaily':
      return elapsedMs >= twiceDailyMs;
    case 'daily':
      return elapsedMs >= dailyMs;
    case 'weekly':
      return elapsedMs >= weeklyMs;
    case 'monthly':
      return elapsedMs >= monthlyMs;
    default:
      return false;
  }
}

/**
 * Build the structured learning export payload (SNAPSHOT).
 *
 * We keep the same structure as the previous JSON export, but we add:
 * - schema: 'epoc-mobile.learning-export@1'
 * - learnerId: optional (phone/matricule)
 * - learnerKey: optional (sync key, used for channels/usernames)
 */
export async function buildLearningExportPayload() {
  const readingStore = useReadingStore();

  const userService = useUser();
  await userService.fetchUser();
  const user = userService.getUser.value as any;

  const deviceInfo = await Device.getInfo();

  const courses = await Promise.all(
    readingStore.readings.map(async (reading) => {
      const path = resolveEpocPath(reading.epocId);
      const epoc = await readEpocContent(path.dir as any, path.id);

      return {
        epocId: reading.epocId,
        title: epoc?.title ?? reading.epocId,
        progressPercent: reading.progress ?? 0,
        lastActivityAt: reading.lastActivityAt,
        sessions: reading.sessions ?? [],
        assessments: summarizeAssessments(reading.assessments),
        badges: {
          unlockedCount: reading.badges?.length ?? 0,
          events: reading.badgeEvents ?? [],
        },
        chaptersProgress: reading.chaptersProgress ?? [],
        exportPending: reading.exportPending ?? false,
      };
    })
  );

  // Prefer a stable human identifier if available (phone, matricule, etc.)
  const learnerId = String(user?.learnerId || user?.username || user?.email || '').trim();

  // Resolve learnerKey if Couchbase sync is enabled (or if salt is configured)
  let learnerKey: string | undefined;
  try {
    const identity = await getCouchbaseIdentity();
    learnerKey = identity.learnerKey;
  } catch {
    learnerKey = undefined;
  }

  return {
    schema: EXPORT_SCHEMA,
    exportVersion: EXPORT_VERSION,
    generatedAt: new Date().toISOString(),

    learnerId: learnerId || undefined,
    learnerKey: learnerKey || undefined,

    learner: {
      id: learnerId || undefined,
      firstname: user?.firstname ?? '',
      lastname: user?.lastname ?? '',
      username: user?.username ?? '',
      email: user?.email ?? '',
    },

    device: {
      platform: deviceInfo.platform,
      osVersion: deviceInfo.osVersion,
      model: deviceInfo.model,
    },

    courses,
  };
}

/**
 * File-based JSON export (legacy / fallback).
 */
export async function exportLearningData(payload?: any) {
  const finalPayload = payload ?? (await buildLearningExportPayload());

  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const fileName = `${EXPORT_FOLDER}/learning-export-${timestamp}.json`;

  await Filesystem.writeFile({
    path: fileName,
    data: JSON.stringify(finalPayload, null, 2),
    directory: Directory.LibraryNoCloud,
    recursive: true,
    encoding: Encoding.UTF8,
  });

  const fileUri = await Filesystem.getUri({
    directory: Directory.LibraryNoCloud,
    path: fileName,
  });

  return { backend: 'file' as const, fileName, fileUri: fileUri.uri, payload: finalPayload };
}

function extractEventsFromPayload(payload: any, snapshotId: string): LearningEventInput[] {
  const events: LearningEventInput[] = [];

  const courses = Array.isArray(payload?.courses) ? payload.courses : [];
  for (const course of courses) {
    const epocId: string | undefined = course?.epocId;

    // Sessions -> events
    const sessions = Array.isArray(course?.sessions) ? course.sessions : [];
    for (const s of sessions) {
      if (!s?.end) continue;
      const ts = String(s.end);
      const start = String(s.start ?? '');
      events.push({
        eventType: 'session_end',
        epocId,
        ts,
        eventKey: start || ts,
        payload: {
          start: s.start,
          end: s.end,
          durationSeconds: s.durationSeconds,
          snapshotId,
        },
      });
    }

    // Assessment attempts -> events
    const assessmentItems = Array.isArray(course?.assessments?.items) ? course.assessments.items : [];
    for (const a of assessmentItems) {
      if (!a?.attemptedAt) continue;
      const ts = String(a.attemptedAt);
      const assessmentId = String(a.id ?? '');
      events.push({
        eventType: 'assessment_attempt',
        epocId,
        ts,
        eventKey: `${assessmentId}:${ts}`,
        payload: {
          assessmentId,
          score: a.score,
          attemptsCount: a.attemptsCount ?? 1,
          snapshotId,
        },
      });
    }

    // Badges -> events
    const badgeEvents = Array.isArray(course?.badges?.events) ? course.badges.events : [];
    for (const b of badgeEvents) {
      if (!b?.unlockedAt || !b?.badgeId) continue;
      const ts = String(b.unlockedAt);
      const badgeId = String(b.badgeId);
      events.push({
        eventType: 'badge_unlocked',
        epocId,
        ts,
        eventKey: `${badgeId}:${ts}`,
        payload: {
          badgeId,
          snapshotId,
        },
      });
    }
  }

  return events;
}

/**
 * Couchbase Lite-based export (preferred):
 * - Save a SNAPSHOT doc (learningExport)
 * - Save granular EVENT docs (learningEvent)
 * - Replication to Sync Gateway happens in the background when configured
 */
export async function exportLearningDataToCouchbase(payload?: any) {
  const finalPayload = payload ?? (await buildLearningExportPayload());

  // Ensure local DB exists (replicator may start if credentials are available)
  await initCouchbaseSync();

  // 1) Save snapshot
  const snapshotSaved = await saveLearningSnapshotDoc(finalPayload);

  // 2) Save events derived from snapshot (safety net: idempotent doc IDs)
  const events = extractEventsFromPayload(finalPayload, snapshotSaved.docId);
  if (events.length > 0) {
    await Promise.all(
      events.map((ev) =>
        saveLearningEventDoc({
          ...ev,
          // ensure schema is stable (server ETL can rely on it)
          payload: { ...(ev.payload ?? {}), schema: EVENT_SCHEMA },
        }).catch(() => null)
      )
    );
  }

  return {
    backend: 'couchbase' as const,
    snapshotId: snapshotSaved.docId,
    eventCount: events.length,
    payload: finalPayload,
  };
}

/**
 * Schedules exports:
 * - on badge validation (exportPending flag), OR
 * - based on frequency (daily / twiceDaily / weekly / monthly), OR
 * - forced (manual trigger)
 *
 * Backend selection:
 * - If Couchbase Sync is enabled (env VITE_CBL_SYNC_URL), exports go to Couchbase Lite + Sync Gateway
 * - Else, fallback to file-based JSON export
 */
export async function triggerScheduledLearningExport(force = false) {
  const settingsStore = useSettingsStore();
  const readingStore = useReadingStore();

  const pendingByBadge =
    settingsStore.settings.learningExportOnBadge &&
    readingStore.readings.some((reading) => reading.exportPending);

  const pendingByFrequency = isFrequencyDue(
    settingsStore.settings.lastLearningExportAt,
    settingsStore.settings.learningExportFrequency as ExportFrequency | undefined
  );

  if (!force && !pendingByBadge && !pendingByFrequency) return null;

  const payload = await buildLearningExportPayload();

  const exported = isCouchbaseSyncEnabled()
    ? await exportLearningDataToCouchbase(payload)
    : await exportLearningData(payload);

  // Clear pending flags once we have a new export snapshot stored
  for (const reading of readingStore.readings) {
    if (reading.exportPending) {
      readingStore.setExportPending(reading.epocId, false);
    }
  }

  settingsStore.updateSettings({ lastLearningExportAt: new Date().toISOString() });

  return exported;
}

export function initLearningExportScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  setInterval(() => {
    triggerScheduledLearningExport().catch(() => null);
  }, SCHEDULE_CHECK_MS);
}

/**
 * Manual share (always uses file-based export),
 * useful as a fallback when Sync Gateway is not reachable.
 */
export async function shareLearningExport() {
  const exported = await exportLearningData();

  await Share.share({
    title: 'Learning export',
    text: 'Offline learning export',
    url: exported.fileUri,
    dialogTitle: 'Share learning export',
  });

  return exported;
}

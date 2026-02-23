import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { toastController } from '@ionic/vue';
import { useRouter } from 'vue-router';

import { useStorage } from '@/composables/useStorage';
import { usePlugin } from '@/composables/usePlugin';
import { useEpocStore } from './epocStore';

// @ts-expect-error json-logic-js has no type definitions
import * as jsonLogic from 'json-logic-js';

import type { Reading, EntityTypes, Verb, ReadingSession } from '@/types/reading';
import type { Badge } from '@/types/epoc';

import { uid } from '@epoc/epoc-types/dist/v1';
import { trackEvent } from '@/utils/matomo';
import { Rule } from '@epoc/epoc-types/src/v1/rule';

import { closeOutline, openOutline, shareOutline } from 'ionicons/icons';

export const useReadingStore = defineStore('reading', () => {
  const storageService = useStorage();
  const epocService = useEpocStore();
  const pluginService = usePlugin();

  // --- State ---
  const router = useRouter();
  const readings = ref<Reading[]>([]);
  const activeSession = ref<{ epocId: string; startAt: Date } | null>(null);

/**
 * Fire-and-forget event logging into Couchbase Lite (snapshot + events mode).
 * We keep it dynamic-imported to avoid any risk of circular deps and to keep startup light.
 */
function queueLearningEvent(ev: {
  eventType: string;
  epocId?: string;
  ts?: string;
  payload?: Record<string, any>;
  eventKey?: string;
}) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  import('@/utils/couchbaseSync')
    .then(({ logLearningEvent }) => {
      logLearningEvent(ev as any);
    })
    .catch(() => null);
}


  function normalizeReading(reading: Partial<Reading>): Reading {
    return {
      epocId: reading.epocId || '',
      progress: reading.progress ?? 0,
      chaptersProgress: reading.chaptersProgress ?? [],
      assessments: (reading.assessments ?? []).map((assessment: any) => ({
        ...assessment,
        attemptedAt: assessment.attemptedAt,
        attemptsCount: assessment.attemptsCount ?? 1,
      })),
      bookmarks: reading.bookmarks ?? [],
      choices: reading.choices ?? [],
      flags: reading.flags ?? [],
      certificateShown: reading.certificateShown ?? false,
      statements: reading.statements ?? {
        global: {},
        chapters: {},
        pages: {},
        contents: {},
        questions: {},
      },
      badges: reading.badges ?? [],
      lastActivityAt: reading.lastActivityAt,
      sessions: reading.sessions ?? [],
      badgeEvents: reading.badgeEvents ?? [],
      exportPending: reading.exportPending ?? false,
    } as Reading;
  }

  function markActivity(reading: Reading) {
    reading.lastActivityAt = new Date().toISOString();
  }

  // --- Getters ---
  const getReadings = computed(() => readings.value);

  // --- Actions ---
  async function fetchReadings() {
    const storedReadings = await storageService.getValue('readings');
    readings.value = storedReadings
      ? (JSON.parse(storedReadings) as Reading[]).map((reading) => normalizeReading(reading))
      : [];
  }

  async function saveReadings() {
    await storageService.setValue('readings', JSON.stringify(readings.value));
  }

  function addReading(epocId: string): Reading {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);

    if (index === -1) {
      readings.value = [
        ...readings.value,
        {
          epocId,
          progress: 0,
          chaptersProgress: [],
          assessments: [],
          bookmarks: [],
          choices: [],
          flags: [],
          certificateShown: false,
          statements: {
            global: {},
            chapters: {},
            pages: {},
            contents: {},
            questions: {},
          },
          badges: [],
          lastActivityAt: undefined,
          sessions: [],
          badgeEvents: [],
          exportPending: false,
        } as Reading,
      ];

      saveReadings();
      return readings.value[readings.value.length - 1];
    }

    return readings.value[index];
  }

  function duplicateReading(epocId: string, newName: string) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index !== -1) {
      readings.value = [
        ...readings.value,
        {
          ...readings.value[index],
          epocId: newName,
        },
      ];
      saveReadings();
    }
  }

  function updateProgress(epocId: string, progress: number) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index !== -1) {
      readings.value[index].progress = progress;
      markActivity(readings.value[index]);
      saveReadings();
    }
  }

  function saveResponses(epocId: string, assessmentId: string, score: number, responses: string[]) {
  const index = readings.value.findIndex((reading) => reading.epocId === epocId);
  if (index === -1) return;

  const attemptedAt = new Date().toISOString();

  const assessmentIndex = readings.value[index].assessments.findIndex(
    (assessment: any) => assessment.id === assessmentId,
  );

  let attemptsCount = 1;

  if (assessmentIndex !== -1) {
    const previousAttempts = readings.value[index].assessments[assessmentIndex].attemptsCount ?? 1;
    attemptsCount = previousAttempts + 1;

    readings.value[index].assessments[assessmentIndex] = {
      id: assessmentId,
      score,
      responses,
      attemptedAt,
      attemptsCount,
    };
  } else {
    attemptsCount = 1;

    readings.value[index].assessments.push({
      id: assessmentId,
      score,
      responses,
      attemptedAt,
      attemptsCount,
    });
  }

  markActivity(readings.value[index]);
  saveReadings();

  // Emit an EVENT doc (granular) — idempotent via (assessmentId + attemptedAt)
  queueLearningEvent({
    eventType: 'assessment_attempt',
    epocId,
    ts: attemptedAt,
    eventKey: `${assessmentId}:${attemptedAt}`,
    payload: {
      assessmentId,
      score,
      attemptsCount,
      responsesCount: Array.isArray(responses) ? responses.length : 0,
    },
  });
}

function saveChapterProgress(epocId: string, chapterId: string, contentId?: string) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index === -1) return;

    const chapterIndex = readings.value[index].chaptersProgress.findIndex(
      (chapter: any) => chapter.id === chapterId,
    );

    if (chapterIndex !== -1) {
      if (contentId && !readings.value[index].chaptersProgress[chapterIndex].contents.includes(contentId)) {
        readings.value[index].chaptersProgress[chapterIndex].contents.push(contentId);
      }
    } else {
      readings.value[index].chaptersProgress.push({
        id: chapterId,
        contents: contentId ? [contentId] : [],
      });
    }

    markActivity(readings.value[index]);
    saveReadings();
  }

  function saveChoices(
    epocId: string,
    choiceId: string,
    responses: any,
    flags: string[],
    flagsToRemove: string[],
  ) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index === -1) return;

    const choiceIndex = readings.value[index].choices.findIndex((choice: any) => choice.id === choiceId);

    if (choiceIndex !== -1) {
      readings.value[index].choices[choiceIndex] = {
        id: choiceId,
        responses,
      };
    } else {
      readings.value[index].choices.push({
        id: choiceId,
        responses,
      });
    }

    readings.value[index].flags = readings.value[index].flags.filter(
      (flag: any) => !flagsToRemove.includes(flag),
    );
    readings.value[index].flags = [...readings.value[index].flags, ...flags];

    markActivity(readings.value[index]);
    saveReadings();
  }

  function resetResponses(epocId: string, assessmentId: string) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index === -1) return;

    const assessmentIndex = readings.value[index].assessments.findIndex(
      (assessment: any) => assessment.id === assessmentId,
    );

    if (assessmentIndex !== -1) {
      readings.value[index].assessments.splice(assessmentIndex, 1);
      saveReadings();
    }
  }

  function saveStatement(
    epocId: string,
    entityType: EntityTypes,
    entityId: uid,
    verb: Verb,
    value: string | number | boolean,
  ) {
    const reading = readings.value.find((r) => r.epocId === epocId);
    if (!reading) return;

    if (!reading.statements) {
      reading.statements = {
        global: {},
        chapters: {},
        pages: {},
        contents: {},
        questions: {},
      } as any;
    }

    if (entityType === 'global') {
      (reading.statements as any).global[verb] = value;
    } else {
      if (!(reading.statements as any)[entityType][entityId]) {
        (reading.statements as any)[entityType][entityId] = {};
      }
      (reading.statements as any)[entityType][entityId][verb] = value;
    }

    if (!reading.badges) reading.badges = [];

    markActivity(reading);
    checkBadges(reading);
    saveReadings();

    pluginService.broadcastMessage({
      event: 'statement',
      statement: {
        epocId,
        entityType,
        entityId,
        verb,
        value,
      },
    });
  }

  function checkBadges(reading: Reading) {
  const epoc = epocService.epoc;
  if (!epoc || !epoc.badges) return;

  for (const [badgeId, badge] of Object.entries(epoc.badges)) {
    if (jsonLogic.apply((badge as any).rule, reading.statements) && !reading.badges.includes(badgeId)) {
      presentBadge(badge as Badge);

      reading.badges.push(badgeId);

      const unlockedAt = new Date().toISOString();

      reading.badgeEvents = reading.badgeEvents ?? [];
      reading.badgeEvents.push({
        badgeId,
        unlockedAt,
      });

      // Mark for snapshot export (scheduler)
      reading.exportPending = true;

      trackEvent(epoc.id, `${epoc.id} / Badge unlocked ${badgeId} ${(badge as any).title}`);

      // Emit an EVENT doc (granular) — idempotent via (badgeId + unlockedAt)
      queueLearningEvent({
        eventType: 'badge_unlocked',
        epocId: reading.epocId,
        ts: unlockedAt,
        eventKey: `${badgeId}:${unlockedAt}`,
        payload: {
          badgeId,
          title: (badge as any).title,
        },
      });
    }
  }
}

async function presentBadge(badge: Badge) {
    const toast = await toastController.create({
      header: 'Nouveau badge débloqué',
      message: badge.title,
      icon: badge.icon.endsWith('.svg')
        ? epocService.rootFolder + badge.icon
        : `/assets/icon/badge/${badge.icon}.svg`,
      cssClass: 'badge-toast',
      position: 'top',
      buttons: [
        {
          icon: shareOutline,
          handler: async () => {
            try {
              await toast.dismiss();
              // Import dynamique pour éviter une dépendance circulaire readingStore <-> learningExport
              const { shareLearningExport } = await import('@/utils/learningExport');
              await shareLearningExport();
            } catch (e) {
              // Annulation utilisateur / plugin indisponible / etc.
            }
          },
        },
        {
          icon: openOutline,
          handler: () => {
            router.push(`/epoc/score/${epocService.epoc?.id}`);
          },
        },
        {
          icon: closeOutline,
          handler: () => toast.dismiss(),
        },
      ],
    });

    await toast.present();
  }

  function removeReading(id: string) {
    readings.value = readings.value.filter((reading) => reading.epocId !== id);
    saveReadings();
  }

  function resetAll() {
    readings.value = [];
    saveReadings();
  }

  function toggleBookmark(epocId: string, index: number) {
    const readingIndex = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (readingIndex === -1) return;

    const bookmarkIndex = readings.value[readingIndex].bookmarks.indexOf(index);
    if (bookmarkIndex === -1) {
      readings.value[readingIndex].bookmarks.push(index);
    } else {
      readings.value[readingIndex].bookmarks.splice(bookmarkIndex, 1);
    }

    markActivity(readings.value[readingIndex]);
    saveReadings();
  }

  function removeBookmark(epocId: string, index: number) {
    const readingIndex = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (readingIndex === -1) return;

    readings.value[readingIndex].bookmarks.splice(index, 1);
    saveReadings();
  }

  function updateCertificateShown(epocId: string, value: boolean) {
    const index = readings.value.findIndex((reading) => reading.epocId === epocId);
    if (index !== -1) {
      readings.value[index].certificateShown = value;
      markActivity(readings.value[index]);
      saveReadings();
    }
  }

  function startSession(epocId: string) {
    if (activeSession.value?.epocId === epocId) return;

    endSession();
    addReading(epocId);

    activeSession.value = {
      epocId,
      startAt: new Date(),
    };
  }

  function endSession() {
  const session = activeSession.value;
  if (!session) return;

  const reading = readings.value.find((r) => r.epocId === session.epocId);
  if (!reading) {
    activeSession.value = null;
    return;
  }

  const endAt = new Date();
  const durationSeconds = Math.max(
    0,
    Math.round((endAt.getTime() - session.startAt.getTime()) / 1000),
  );

  const completedSession: ReadingSession = {
    start: session.startAt.toISOString(),
    end: endAt.toISOString(),
    durationSeconds,
  };

  reading.sessions = reading.sessions ?? [];
  reading.sessions.push(completedSession);

  markActivity(reading);
  activeSession.value = null;
  saveReadings();

  // Emit an EVENT doc (granular) — idempotent via start timestamp
  queueLearningEvent({
    eventType: 'session_end',
    epocId: reading.epocId,
    ts: completedSession.end,
    eventKey: completedSession.start,
    payload: {
      start: completedSession.start,
      end: completedSession.end,
      durationSeconds: completedSession.durationSeconds,
      route: router.currentRoute.value?.fullPath,
    },
  });
}

function setExportPending(epocId: string, value: boolean) {
    const reading = readings.value.find((r) => r.epocId === epocId);
    if (!reading) return;

    reading.exportPending = value;
    saveReadings();
  }

  function isUnlocked(reading: Reading, rule: Rule) {
    return jsonLogic.apply(rule as any, (reading as any).statements);
  }

  // --- Initialization ---
  fetchReadings();

  return {
    // State
    readings,

    // Getters
    getReadings,

    // Actions
    fetchReadings,
    saveReadings,
    addReading,
    duplicateReading,
    updateProgress,
    saveResponses,
    saveChapterProgress,
    saveChoices,
    resetResponses,
    saveStatement,
    checkBadges,
    presentBadge,
    removeReading,
    resetAll,
    toggleBookmark,
    removeBookmark,
    updateCertificateShown,
    isUnlocked,
    startSession,
    endSession,
    setExportPending,
  };
});

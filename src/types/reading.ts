import { uid } from '@epoc/epoc-types/dist/v1';

export type EntityTypes = 'global' | 'chapters' | 'pages' | 'contents' | 'questions';

export type Verb =
  | 'played'
  | 'watched'
  | 'listened'
  | 'started'
  | 'attempted'
  | 'scored'
  | 'completed'
  | 'passed'
  | 'viewed'
  | 'read';

export type Verbs = { [key in Verb]?: string | number | boolean };

export interface Statements {
  global: Verbs;
  chapters: Record<uid, Verbs>;
  pages: Record<uid, Verbs>;
  contents: Record<uid, Verbs>;
  questions: Record<uid, Verbs>;
}

export type ChapterProgress = { id: uid; contents: uid[] };

export interface ReadingSession {
  start: string; // ISO
  end: string; // ISO
  durationSeconds: number;
}

export interface BadgeEvent {
  badgeId: uid;
  unlockedAt: string; // ISO
}

export class UserAssessment {
  id: string;
  score: number;
  responses: string[];

  // PRO tracking
  attemptedAt?: string; // ISO
  attemptsCount?: number;
}

export class UserChoice {
  id: string;
  responses: string[];
}

export class Reading {
  epocId: string;
  progress: number;

  chaptersProgress: ChapterProgress[];
  assessments: UserAssessment[];

  bookmarks: number[];
  choices: UserChoice[];
  flags: uid[];

  certificateShown: boolean;

  statements: Statements;

  // Badge IDs
  badges: uid[];

  // PRO tracking
  lastActivityAt?: string;
  sessions?: ReadingSession[];
  badgeEvents?: BadgeEvent[];
  exportPending?: boolean;
}

import { uri } from '@epoc/epoc-types/dist/v2';

export type LearningExportFrequency = 'manual' | 'daily' | 'twiceDaily' | 'weekly' | 'monthly';

export class Settings {
  debug: boolean;
  font: string;
  fontSize: number;
  lineHeight: number;
  lang: string;
  theme: 'auto' | 'dark' | 'light';
  customLibrairies: uri[];
  devMode: boolean;
  isUserOptIn: boolean;

  /**
   * PRO — offline tracking export (snapshot scheduler)
   * These flags are used by src/utils/learningExport.ts
   */
  learningExportOnBadge?: boolean;
  learningExportFrequency?: LearningExportFrequency;
  lastLearningExportAt?: string;
}

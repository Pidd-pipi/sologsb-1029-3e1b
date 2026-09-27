export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'teacher' | 'review';
export type ThemeMode = 'light' | 'dark';

export interface Sentence {
  id: string;
  text: string;
  translation: string;
  note: string;
}

export interface Lesson {
  id: string;
  courseId: string;
  title: string;
  subtitle: string;
  level: string;
  estimatedMinutes: number;
  downloaded: boolean;
  sentences: Sentence[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  level: string;
  accent: string;
  lessons: Lesson[];
}

export interface TokenResult {
  index: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
}

export interface SentenceAttempt {
  sentenceId: string;
  source: string;
  answer: string;
  tokens: TokenResult[];
  score: number;
}

export interface PracticeAttempt {
  id: string;
  lessonId: string;
  lessonTitle: string;
  courseTitle: string;
  submittedAt: string;
  score: number;
  sentenceAttempts: SentenceAttempt[];
  teacherFeedback: string;
}

export interface LessonProgress {
  answers: Record<string, string>;
  activeSentenceId: string;
  updatedAt: string;
}

/** 错题复习队列中的一个错词，按原课程、原句与稳定词位唯一确定 */
export interface ReviewQueueItem {
  key: string;
  lessonId: string;
  sentenceId: string;
  /** 稳定词位：原文词索引；多词项为锚点词位 */
  position: number;
  /** expected 为空（多词）时用实际词形参与定位，区分同一锚点的多个多词项 */
  anchorActual: string;
  expected: string;
  category: ErrorCategory;
  reason: string;
  /** 最近一次提交/复习时学员实际输入 */
  lastActual: string;
  /** 连续答对次数：达到 2 即移出队列；答错清零 */
  correctStreak: number;
  firstAddedAt: string;
  lastWrongAt: string;
  /** 快照的课程名，课程库变更时仍能展示出处 */
  courseTitle: string;
  lessonTitle: string;
  source: string;
}

export interface ReviewWordResult {
  key: string;
  position: number;
  expected: string;
  actual: string;
  correct: boolean;
  category: ErrorCategory;
  reason: string;
  correctStreakBefore: number;
  correctStreakAfter: number;
  removed: boolean;
}

export interface ReviewResult {
  id: string;
  sessionId: string;
  lessonId: string;
  sentenceId: string;
  source: string;
  answer: string;
  answeredAt: string;
  words: ReviewWordResult[];
}

export interface ActiveReviewSession {
  id: string;
  startedAt: string;
  /** 当前仍需练习的“课程/句子”有序键 */
  sentenceOrder: string[];
  /** 本会话各句练习次数 */
  rounds: Record<string, number>;
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
  reviewQueue: ReviewQueueItem[];
  reviewResults: ReviewResult[];
  activeReview: ActiveReviewSession | null;
  reviewDrafts: Record<string, string>;
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}

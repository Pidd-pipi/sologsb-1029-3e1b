export type ErrorCategory = 'unclassified' | 'spelling' | 'omitted' | 'extra' | 'punctuation' | 'grammar';
export type PracticeView = 'library' | 'practice' | 'result' | 'review' | 'teacher';
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
  /** Position of the token in the expected sentence; -1 for extra words typed by the learner. */
  sourceIndex?: number;
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
  courseId: string;
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

/** One wrong word waiting in the spaced review queue, identified by sentence + word position. */
export interface ReviewQueueItem {
  id: string;
  courseId: string;
  courseTitle: string;
  lessonId: string;
  lessonTitle: string;
  sentenceId: string;
  source: string;
  translation: string;
  /** Word position inside the expected sentence; -1 marks an extra word the learner typed. */
  tokenIndex: number;
  expected: string;
  actual: string;
  category: ErrorCategory;
  reason: string;
  attemptId: string;
  enqueuedAt: string;
  /** Consecutive correct answers during review; the item leaves the queue at 2. */
  streak: number;
  lastReviewedAt: string;
}

export interface ReviewResult {
  id: string;
  sessionId: string;
  courseId: string;
  lessonId: string;
  sentenceId: string;
  tokenIndex: number;
  expected: string;
  answer: string;
  correct: boolean;
  streakAfter: number;
  removed: boolean;
  reviewedAt: string;
}

export interface PersistedState {
  schemaVersion: 2;
  courses: Course[];
  attempts: PracticeAttempt[];
  progress: Record<string, LessonProgress>;
  reviewQueue: ReviewQueueItem[];
  reviewResults: ReviewResult[];
  activeLessonId: string;
  activeSentenceId: string;
  theme: ThemeMode;
  fontScale: number;
  role: 'learner' | 'teacher';
}

export interface TextSegment {
  index: number;
  display: string;
  normalized: string;
}

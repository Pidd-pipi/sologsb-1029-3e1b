import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import {
  enqueueAttemptErrors,
  gradeReviewSentence,
  rebuildQueueFromHistory,
  syncClassificationToQueue,
  type ContextLookup,
  type EnqueueSummary,
  type ReviewVerdict
} from './review';
import type { Course, ErrorCategory, Lesson, PersistedState, PracticeAttempt, Sentence } from './types';

/** v1 records predate courseId on attempts; it is filled in during migration. */
type StoredAttempt = Omit<PracticeAttempt, 'courseId'> & { courseId?: string };

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

interface StoredState {
  schemaVersion?: number;
  courses?: PersistedState['courses'];
  attempts?: StoredAttempt[];
  progress?: PersistedState['progress'];
  reviewQueue?: PersistedState['reviewQueue'];
  reviewResults?: PersistedState['reviewResults'];
  activeLessonId?: string;
  activeSentenceId?: string;
  theme?: PersistedState['theme'];
  fontScale?: number;
  role?: PersistedState['role'];
}

function findSentenceIn(courses: Course[], lessonId: string, sentenceId: string) {
  for (const course of courses) {
    const lesson = course.lessons.find((item) => item.id === lessonId);
    if (lesson) {
      const sentence = lesson.sentences.find((item) => item.id === sentenceId);
      if (sentence) return { course, lesson, sentence };
    }
  }
  return undefined;
}

function contextLookupFor(courses: Course[]): ContextLookup {
  return (lessonId, sentenceId) => {
    const found = findSentenceIn(courses, lessonId, sentenceId);
    if (!found) return undefined;
    return {
      courseId: found.course.id,
      courseTitle: found.course.title,
      lessonId: found.lesson.id,
      lessonTitle: found.lesson.title,
      translation: found.sentence.translation
    };
  };
}

/** Upgrades older local records in place: practice history and teacher feedback are always preserved. */
function migrateState(stored: StoredState): PersistedState {
  const courses = stored.courses ?? createInitialState().courses;
  const attempts = (stored.attempts ?? []).map((attempt) => ({
    ...attempt,
    courseId: attempt.courseId ?? courses.find((course) => course.lessons.some((lesson) => lesson.id === attempt.lessonId))?.id ?? ''
  }));
  const next: PersistedState = {
    schemaVersion: 2,
    courses,
    attempts,
    progress: stored.progress ?? {},
    reviewQueue: Array.isArray(stored.reviewQueue) ? stored.reviewQueue : [],
    reviewResults: Array.isArray(stored.reviewResults) ? stored.reviewResults : [],
    activeLessonId: stored.activeLessonId ?? '',
    activeSentenceId: stored.activeSentenceId ?? '',
    theme: stored.theme ?? 'light',
    fontScale: typeof stored.fontScale === 'number' ? stored.fontScale : 1,
    role: stored.role ?? 'learner'
  };
  // v1 records never had a review queue: seed it once from existing wrong words so they stay reviewable.
  if (stored.schemaVersion === 1 || (stored.schemaVersion === undefined && Array.isArray(stored.attempts))) {
    next.reviewQueue = rebuildQueueFromHistory(next.attempts, contextLookupFor(courses));
  }
  return next;
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredState;
      return migrateState(parsed);
    }
  } catch {
    // Falls back to the sample course when the local draft is malformed.
  }
  return createInitialState();
}

export const state = reactive<PersistedState>(loadState());

export const persist = () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

watch(state, persist, { deep: true });

const liveContextLookup: ContextLookup = (lessonId, sentenceId) => {
  const found = findSentenceIn(state.courses, lessonId, sentenceId);
  if (!found) return undefined;
  return {
    courseId: found.course.id,
    courseTitle: found.course.title,
    lessonId: found.lesson.id,
    lessonTitle: found.lesson.title,
    translation: found.sentence.translation
  };
};

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);
export const sentenceById = (sentenceId: string): Sentence | undefined =>
  lessons().flatMap((lesson) => lesson.sentences).find((sentence) => sentence.id === sentenceId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

/** Saves a submitted attempt and collects its wrong words into the review queue. */
export function saveAttemptWithReview(attempt: PracticeAttempt): EnqueueSummary {
  state.attempts.unshift(attempt);
  return enqueueAttemptErrors(state.reviewQueue, attempt, liveContextLookup);
}

export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: ErrorCategory; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const sentence = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId);
  const token = sentence?.tokens.find((item) => item.index === tokenIndex);
  if (token) {
    Object.assign(token, patch);
    // Keep the same queued word in sync: same original course, sentence and word position.
    syncClassificationToQueue(state.reviewQueue, sentenceId, token, sentence, patch);
  }
}

/** Grades one review sentence, records per-word results, and applies the queue rules. */
export function submitReviewAnswer(sentenceId: string, answer: string, sessionId: string): ReviewVerdict[] {
  const { verdicts, results } = gradeReviewSentence(state.reviewQueue, sentenceId, answer, sessionId);
  state.reviewResults.push(...results);
  return verdicts;
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    schemaVersion: state.schemaVersion,
    attempts: state.attempts,
    progress: state.progress,
    reviewQueue: state.reviewQueue,
    reviewResults: state.reviewResults
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}

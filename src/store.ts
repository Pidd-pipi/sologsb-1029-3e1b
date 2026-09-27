import { reactive, watch } from 'vue';
import { createInitialState } from './data';
import type {
  ActiveReviewSession,
  Lesson,
  PersistedState,
  PracticeAttempt,
  ReviewQueueItem,
  ReviewResult,
  ReviewWordResult,
  TokenResult
} from './types';
import { compareSentence, stableTokenPositions } from './utils';

const STORAGE_KEY = 'sologsb-1029-dictation-state-v1';

export const reviewKey = (lessonId: string, sentenceId: string, position: number, expected: string, anchorActual: string) =>
  `${lessonId}|${sentenceId}|${position}|${expected}|${expected ? '' : anchorActual}`;

function findCourseTitle(state: PersistedState, lessonId: string): { courseTitle: string; lessonTitle: string } {
  for (const course of state.courses) {
    const lesson = course.lessons.find((item) => item.id === lessonId);
    if (lesson) return { courseTitle: course.title, lessonTitle: lesson.title };
  }
  return { courseTitle: '', lessonTitle: '' };
}

/**
 * 从历史提交回填复习队列：按提交时间从旧到新处理，使队列顺序贴近首次出错顺序。
 * 仅用于 v1 → v2 迁移；旧练习记录与教师反馈保持原样。
 */
function backfillReviewQueue(state: PersistedState): ReviewQueueItem[] {
  const items: ReviewQueueItem[] = [];
  const indexByKey = new Map<string, number>();
  const chronological = [...state.attempts].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const attempt of chronological) {
    const titles = findCourseTitle(state, attempt.lessonId);
    for (const sentence of attempt.sentenceAttempts) {
      const positions = stableTokenPositions(sentence.source, sentence.answer);
      sentence.tokens.forEach((token, tokenArrayIndex) => {
        if (token.correct) return;
        const anchor = positions[tokenArrayIndex] ?? { position: token.index, anchorActual: token.expected ? '' : token.actual };
        const key = reviewKey(attempt.lessonId, sentence.sentenceId, anchor.position, token.expected, anchor.anchorActual);
        const existingIndex = indexByKey.get(key);
        if (existingIndex === undefined) {
          indexByKey.set(key, items.length);
          items.push({
            key,
            lessonId: attempt.lessonId,
            sentenceId: sentence.sentenceId,
            position: anchor.position,
            anchorActual: anchor.anchorActual,
            expected: token.expected,
            category: token.category,
            reason: token.reason,
            lastActual: token.actual,
            correctStreak: 0,
            firstAddedAt: attempt.submittedAt,
            lastWrongAt: attempt.submittedAt,
            courseTitle: attempt.courseTitle || titles.courseTitle,
            lessonTitle: attempt.lessonTitle || titles.lessonTitle,
            source: sentence.source
          });
        } else {
          // 同一个词在更晚的提交中仍错：保留已选分类/原因，更新词形与最近出错时间
          const existing = items[existingIndex];
          existing.lastActual = token.actual;
          existing.lastWrongAt = attempt.submittedAt;
          existing.source = sentence.source;
          if (attempt.courseTitle) existing.courseTitle = attempt.courseTitle;
          if (attempt.lessonTitle) existing.lessonTitle = attempt.lessonTitle;
        }
      });
    }
  }
  return items;
}

function migrate(raw: Partial<PersistedState>): PersistedState {
  const initial = createInitialState();
  const base: PersistedState = {
    ...initial,
    ...raw,
    schemaVersion: 2,
    courses: raw.courses ?? initial.courses,
    attempts: raw.attempts ?? initial.attempts,
    progress: raw.progress ?? initial.progress,
    reviewQueue: [],
    reviewResults: [],
    activeReview: null,
    reviewDrafts: {}
  };
  base.reviewQueue = backfillReviewQueue(base);
  // 清理指向已不存在句子的残留复习会话
  if (base.activeReview && !base.reviewQueue.length) base.activeReview = null;
  return base;
}

function loadState(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown> & { courses?: PersistedState['courses']; attempts?: PersistedState['attempts']; progress?: PersistedState['progress']; schemaVersion?: number };
      if (parsed.schemaVersion === 2 && parsed.courses) return parsed as unknown as PersistedState;
      if (parsed.schemaVersion === 1 && parsed.courses) return migrate(parsed as unknown as Partial<PersistedState>);
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

export const lessons = (): Lesson[] => state.courses.flatMap((course) => course.lessons);
export const lessonById = (id: string): Lesson | undefined => lessons().find((lesson) => lesson.id === id);
export const courseForLesson = (lessonId: string) => state.courses.find((course) => course.id === lessonById(lessonId)?.courseId);

export function setDownloaded(lessonId: string, value: boolean) {
  const lesson = lessonById(lessonId);
  if (lesson) lesson.downloaded = value;
}

/** 提交后把错词按原课程、原句和稳定词位收进队列；已在队列中的词重新出错则回到队尾并清零连续次数 */
export function enqueueAttemptErrors(attempt: PracticeAttempt) {
  const titles = findCourseTitle(state, attempt.lessonId);
  const courseTitle = attempt.courseTitle || titles.courseTitle;
  const lessonTitle = attempt.lessonTitle || titles.lessonTitle;
  for (const sentence of attempt.sentenceAttempts) {
    const positions = stableTokenPositions(sentence.source, sentence.answer);
    sentence.tokens.forEach((token, tokenArrayIndex) => {
      if (token.correct) return;
      const anchor = positions[tokenArrayIndex] ?? { position: token.index, anchorActual: token.expected ? '' : token.actual };
      const key = reviewKey(attempt.lessonId, sentence.sentenceId, anchor.position, token.expected, anchor.anchorActual);
      const now = attempt.submittedAt;
      const existing = state.reviewQueue.find((item) => item.key === key);
      if (existing) {
        existing.lastActual = token.actual;
        existing.correctStreak = 0;
        existing.lastWrongAt = now;
        existing.source = sentence.source;
        if (courseTitle) existing.courseTitle = courseTitle;
        if (lessonTitle) existing.lessonTitle = lessonTitle;
        if (!existing.reason && token.reason) existing.reason = token.reason;
        // 重新出错：作为新错词移到队尾
        state.reviewQueue.push(...state.reviewQueue.splice(state.reviewQueue.findIndex((item) => item.key === key), 1));
      } else {
        state.reviewQueue.push({
          key,
          lessonId: attempt.lessonId,
          sentenceId: sentence.sentenceId,
          position: anchor.position,
          anchorActual: anchor.anchorActual,
          expected: token.expected,
          category: token.category,
          reason: token.reason,
          lastActual: token.actual,
          correctStreak: 0,
          firstAddedAt: now,
          lastWrongAt: now,
          courseTitle,
          lessonTitle,
          source: sentence.source
        });
      }
    });
  }
}

export function saveAttempt(attempt: PracticeAttempt) {
  state.attempts.unshift(attempt);
  enqueueAttemptErrors(attempt);
}

/** 调整错误分类或原因时同步到复习队列中的同一条；历史记录本身也一并更新 */
export function updateTokenClassification(attemptId: string, sentenceId: string, tokenIndex: number, patch: { category?: TokenResult['category']; reason?: string }) {
  const attempt = state.attempts.find((item) => item.id === attemptId);
  const sentence = attempt?.sentenceAttempts.find((item) => item.sentenceId === sentenceId);
  const token = sentence?.tokens.find((item) => item.index === tokenIndex);
  if (token) Object.assign(token, patch);
  if (!attempt || !sentence || !token || token.correct) return;
  const positions = stableTokenPositions(sentence.source, sentence.answer);
  const tokenArrayIndex = sentence.tokens.findIndex((item) => item.index === tokenIndex);
  const anchor = positions[tokenArrayIndex] ?? { position: token.index, anchorActual: token.expected ? '' : token.actual };
  const key = reviewKey(attempt.lessonId, sentenceId, anchor.position, token.expected, anchor.anchorActual);
  const queued = state.reviewQueue.find((item) => item.key === key);
  if (queued) Object.assign(queued, patch);
}

const sentenceKeyOf = (item: ReviewQueueItem) => `${item.lessonId}|${item.sentenceId}`;

export function startReviewSession(): ActiveReviewSession | null {
  if (!state.reviewQueue.length) return null;
  const sentenceOrder: string[] = [];
  for (const item of state.reviewQueue) {
    const sentenceKey = sentenceKeyOf(item);
    if (!sentenceOrder.includes(sentenceKey)) sentenceOrder.push(sentenceKey);
  }
  const session: ActiveReviewSession = {
    id: `review-${Date.now()}`,
    startedAt: new Date().toISOString(),
    sentenceOrder,
    rounds: {}
  };
  state.activeReview = session;
  return session;
}

export function exitReviewSession() {
  state.activeReview = null;
}

export interface SentenceGrade {
  result: ReviewResult;
  /** 本次判分后该句是否已无错词（需轮转到队尾或会话结束） */
  sentenceCleared: boolean;
  removedCount: number;
  queueLengthBefore: number;
}

/**
 * 复习单句判分：
 * - 同词连续答对两次才移出队列；答错清零连续次数并把该词提到队首；
 * - 句子仍有错词时留在会话队首，全部清空后轮转到队尾，全部清空则会话结束。
 */
export function gradeReviewSentence(lessonId: string, sentenceId: string, source: string, answer: string): SentenceGrade | null {
  const session = state.activeReview;
  if (!session) return null;
  const tokens = compareSentence(source, answer);
  const positions = stableTokenPositions(source, answer);
  const queueIndex = state.reviewQueue.findIndex((item) => item.lessonId === lessonId && item.sentenceId === sentenceId);
  if (queueIndex === -1) return null;

  const now = new Date().toISOString();
  const wordResults: ReviewWordResult[] = [];
  const wrongKeys: string[] = [];
  let removedCount = 0;

  for (const item of state.reviewQueue.filter((entry) => entry.lessonId === lessonId && entry.sentenceId === sentenceId)) {
    // 依据稳定词位 + 实际词形匹配本次答案中的词；多词项需要同时写出相同的多余词才算错
    const tokenArrayIndex = tokens.findIndex((token, index) => {
      const anchor = positions[index];
      if (!anchor) return false;
      if (item.expected) {
        return anchor.position === item.position && !anchor.anchorActual && token.expected !== '';
      }
      return anchor.position === item.position && anchor.anchorActual === item.anchorActual;
    });
    const token: TokenResult | undefined = tokens[tokenArrayIndex];
    const streakBefore = item.correctStreak;
    let correct: boolean;
    if (token) {
      correct = token.correct;
      item.lastActual = token.actual;
    } else {
      // 多词项未再写出，视为该多余词已纠正；其余词在本次答案中无对齐，按漏写处理
      correct = !item.expected;
      if (!correct) item.lastActual = '';
    }

    if (correct) {
      item.correctStreak = streakBefore + 1;
    } else {
      item.correctStreak = 0;
      item.lastWrongAt = now;
      if (token && token.category !== 'unclassified') item.category = token.category;
      wrongKeys.push(item.key);
    }

    const removed = item.correctStreak >= 2;
    if (removed) removedCount += 1;
    wordResults.push({
      key: item.key,
      position: item.position,
      expected: item.expected,
      actual: item.lastActual,
      correct,
      category: item.category,
      reason: item.reason,
      correctStreakBefore: streakBefore,
      correctStreakAfter: item.correctStreak,
      removed
    });
  }

  // 连续答对两次：移出队列
  if (removedCount) {
    const removedSet = new Set(wordResults.filter((word) => word.removed).map((word) => word.key));
    state.reviewQueue = state.reviewQueue.filter((item) => !removedSet.has(item.key));
  }

  // 答错的词按原队列相对顺序提到队首
  if (wrongKeys.length) {
    const wrongSet = new Set(wrongKeys);
    const wrong = state.reviewQueue.filter((item) => wrongSet.has(item.key));
    const rest = state.reviewQueue.filter((item) => !wrongSet.has(item.key));
    state.reviewQueue = [...wrong, ...rest];
  }

  const sentenceKey = `${lessonId}|${sentenceId}`;
  session.rounds[sentenceKey] = (session.rounds[sentenceKey] ?? 0) + 1;
  const sentenceCleared = !state.reviewQueue.some((item) => sentenceKeyOf(item) === sentenceKey);
  if (sentenceCleared) {
    // 本句词全部连续答对两次并移出队列，会话中移除该句
    session.sentenceOrder = session.sentenceOrder.filter((key) => key !== sentenceKey);
  } else {
    // 仍有待练词：答错留队首；第一次答对则轮转到队尾，稍后回来完成第二次
    const rest = session.sentenceOrder.filter((key) => key !== sentenceKey);
    session.sentenceOrder = wrongKeys.length ? [sentenceKey, ...rest] : [...rest, sentenceKey];
  }
  if (!session.sentenceOrder.length) state.activeReview = null;
  delete state.reviewDrafts[sentenceKey];

  const result: ReviewResult = {
    id: `review-result-${Date.now()}-${wordResults.length}`,
    sessionId: session.id,
    lessonId,
    sentenceId,
    source,
    answer,
    answeredAt: now,
    words: wordResults
  };
  state.reviewResults.unshift(result);
  return { result, sentenceCleared, removedCount, queueLengthBefore: state.reviewQueue.length + removedCount };
}

export function exportRecords(): string {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    application: 'EchoStep 移动听写',
    schemaVersion: 2,
    attempts: state.attempts,
    progress: state.progress,
    reviewQueue: state.reviewQueue,
    reviewResults: state.reviewResults,
    activeReview: state.activeReview,
    reviewDrafts: state.reviewDrafts
  }, null, 2);
}

export function resetDemo() {
  const fresh = createInitialState();
  Object.assign(state, fresh);
}

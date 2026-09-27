import { normalizeToken, segmentText } from './utils';
import type {
  ErrorCategory,
  PracticeAttempt,
  ReviewQueueItem,
  ReviewResult,
  SentenceAttempt,
  TokenResult
} from './types';

export interface SentenceContext {
  courseId: string;
  courseTitle: string;
  lessonId: string;
  lessonTitle: string;
  translation: string;
}

/** Resolves course/lesson context for a sentence; used to label queue items without importing the store. */
export type ContextLookup = (lessonId: string, sentenceId: string) => SentenceContext | undefined;

export type EnqueueMode = 'live' | 'history';

export interface EnqueueSummary {
  added: number;
  updated: number;
}

/**
 * Stable identity of a queue item: the original sentence plus the word position inside it.
 * Extra words (not present in the source sentence) use position -1 and the typed word.
 */
export function queueItemId(sentenceId: string, sourceIndex: number, actual: string): string {
  return sourceIndex >= 0 ? `review-${sentenceId}-w${sourceIndex}` : `review-${sentenceId}-x-${normalizeToken(actual) || 'empty'}`;
}

/** Token position that identifies a queue item; falls back to a source replay for records built before sourceIndex existed. */
export function tokenPosition(token: TokenResult, sentence: SentenceAttempt | undefined): number {
  if (typeof token.sourceIndex === 'number') return token.sourceIndex;
  if (token.expected) {
    const sourceIndex = segmentText(sentence?.source ?? '').findIndex((segment) => segment.display === token.expected);
    if (sourceIndex >= 0) return sourceIndex;
  }
  return -1;
}

/** Sentence + word position that identifies a queue item for a result token. */
function tokenKey(token: TokenResult, sentence: SentenceAttempt | undefined): { sentenceId: string; position: number; actual: string } {
  return { sentenceId: sentence?.sentenceId ?? '', position: tokenPosition(token, sentence), actual: token.actual };
}

function findQueueItem(queue: ReviewQueueItem[], sentenceId: string, position: number, actual: string): ReviewQueueItem | undefined {
  const id = queueItemId(sentenceId, position, actual);
  return queue.find((item) => item.id === id);
}

function buildQueueItem(
  attempt: PracticeAttempt,
  sentence: SentenceAttempt,
  token: TokenResult,
  position: number,
  context: SentenceContext | undefined,
  enqueuedAt: string
): ReviewQueueItem {
  return {
    id: queueItemId(sentence.sentenceId, position, token.actual),
    courseId: context?.courseId ?? attempt.courseId,
    courseTitle: context?.courseTitle ?? attempt.courseTitle,
    lessonId: context?.lessonId ?? attempt.lessonId,
    lessonTitle: context?.lessonTitle ?? attempt.lessonTitle,
    sentenceId: sentence.sentenceId,
    source: sentence.source,
    translation: context?.translation ?? '',
    tokenIndex: position,
    expected: token.expected,
    actual: token.actual,
    category: token.category,
    reason: token.reason,
    attemptId: attempt.id,
    enqueuedAt,
    streak: 0,
    lastReviewedAt: ''
  };
}

/**
 * Collects the wrong words of a freshly submitted attempt into the queue.
 * Items already queued keep their position and streak; only the latest typed answer is refreshed.
 * Classification/reason edits stay owned by the learner and are never overwritten here.
 */
export function enqueueAttemptErrors(
  queue: ReviewQueueItem[],
  attempt: PracticeAttempt,
  lookup: ContextLookup,
  now: string = new Date().toISOString()
): EnqueueSummary {
  const summary: EnqueueSummary = { added: 0, updated: 0 };
  for (const sentence of attempt.sentenceAttempts) {
    const context = lookup(attempt.lessonId, sentence.sentenceId);
    for (const token of sentence.tokens) {
      if (token.correct) continue;
      const { position, actual } = tokenKey(token, sentence);
      const existing = findQueueItem(queue, sentence.sentenceId, position, actual);
      if (existing) {
        existing.actual = token.actual;
        summary.updated += 1;
      } else {
        queue.push(buildQueueItem(attempt, sentence, token, position, context, now));
        summary.added += 1;
      }
    }
  }
  return summary;
}

/**
 * Rebuilds the queue from historical attempts. Used once when upgrading v1 records.
 * The newest occurrence of each word wins so the classification/reason edited later is kept.
 */
export function rebuildQueueFromHistory(attempts: PracticeAttempt[], lookup: ContextLookup): ReviewQueueItem[] {
  const queue: ReviewQueueItem[] = [];
  const ordered = [...attempts].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  for (const attempt of ordered) {
    for (const sentence of attempt.sentenceAttempts) {
      const context = lookup(attempt.lessonId, sentence.sentenceId);
      for (const token of sentence.tokens) {
        if (token.correct) continue;
        const { position, actual } = tokenKey(token, sentence);
        const existing = findQueueItem(queue, sentence.sentenceId, position, actual);
        if (existing) {
          // history path: later submissions / later edits are authoritative
          existing.courseId = context?.courseId ?? attempt.courseId;
          existing.courseTitle = context?.courseTitle ?? attempt.courseTitle;
          existing.lessonId = context?.lessonId ?? attempt.lessonId;
          existing.lessonTitle = context?.lessonTitle ?? attempt.lessonTitle;
          existing.source = sentence.source;
          existing.translation = context?.translation ?? existing.translation;
          existing.expected = token.expected;
          existing.actual = token.actual;
          existing.category = token.category;
          existing.reason = token.reason;
          existing.attemptId = attempt.id;
          existing.enqueuedAt = attempt.submittedAt;
        } else {
          queue.push(buildQueueItem(attempt, sentence, token, position, context, attempt.submittedAt));
        }
      }
    }
  }
  return queue;
}

export interface ReviewVerdict {
  item: ReviewQueueItem;
  correct: boolean;
  expected: string;
  answer: string;
}

function isPunctuationItem(item: ReviewQueueItem): boolean {
  return item.tokenIndex >= 0 && /^[^\p{L}\p{N}]+$/u.test(item.expected);
}

function isPunctuationToken(text: string): boolean {
  return /^[^\s\p{L}\p{N}]+$/u.test(text);
}

/**
 * Grades one review sentence. Every still-queued word in the sentence is checked against
 * the typed answer. Two consecutive correct answers remove the item; a wrong answer resets
 * the streak and moves the item back to the queue head (sentence block stays first).
 */
export function gradeReviewSentence(
  queue: ReviewQueueItem[],
  sentenceId: string,
  answer: string,
  sessionId: string,
  now: string = new Date().toISOString()
): { verdicts: ReviewVerdict[]; results: ReviewResult[] } {
  const items = queue.filter((item) => item.sentenceId === sentenceId);
  const answerSegments = segmentText(answer);
  const answerWords = answerSegments.filter((segment) => !isPunctuationToken(segment.display));
  const consumedWordIndexes = new Set<number>();
  const verdicts: ReviewVerdict[] = [];

  for (const item of items) {
    let correct = false;
    if (isPunctuationItem(item)) {
      correct = answer.includes(item.expected);
    } else if (item.tokenIndex >= 0) {
      const target = normalizeToken(item.expected);
      const matchIndex = answerWords.findIndex((segment, index) => !consumedWordIndexes.has(index) && segment.normalized === target);
      if (matchIndex >= 0) {
        consumedWordIndexes.add(matchIndex);
        correct = true;
      }
    } else {
      // Extra word from the original mistake: it must not appear this time.
      correct = !answerWords.some((segment) => segment.normalized === normalizeToken(item.actual));
    }
    verdicts.push({ item, correct, expected: item.expected || item.actual, answer });
  }

  const results: ReviewResult[] = [];
  const failed = new Set<ReviewQueueItem>();

  for (const verdict of verdicts) {
    const item = verdict.item;
    if (verdict.correct) {
      item.streak += 1;
    } else {
      item.streak = 0;
      failed.add(item);
    }
    item.lastReviewedAt = now;
  }

  // Words with two consecutive correct answers leave the queue.
  for (const item of items) {
    if (!failed.has(item) && item.streak >= 2) {
      const index = queue.indexOf(item);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  // Failed words return to the queue head; reverse order keeps their relative sequence.
  const failedItems = items.filter((item) => failed.has(item));
  for (let index = failedItems.length - 1; index >= 0; index -= 1) {
    const current = failedItems[index];
    const at = queue.indexOf(current);
    if (at > 0) {
      queue.splice(at, 1);
      queue.unshift(current);
    }
  }

  for (const [order, verdict] of verdicts.entries()) {
    results.push({
      id: `${sessionId}-${verdict.item.sentenceId}-${verdict.item.tokenIndex}-${now}-${order}`,
      sessionId,
      courseId: verdict.item.courseId,
      lessonId: verdict.item.lessonId,
      sentenceId: verdict.item.sentenceId,
      tokenIndex: verdict.item.tokenIndex,
      expected: verdict.item.expected || verdict.item.actual,
      answer,
      correct: verdict.correct,
      streakAfter: verdict.item.streak,
      removed: verdict.correct && !queue.includes(verdict.item),
      reviewedAt: now
    });
  }

  verdicts.sort((a, b) => a.item.tokenIndex - b.item.tokenIndex);
  return { verdicts, results };
}

/** Reflects an edited error category/reason on the matching queue item (same sentence + word position). */
export function syncClassificationToQueue(
  queue: ReviewQueueItem[],
  sentenceId: string,
  token: TokenResult,
  sentence: SentenceAttempt | undefined,
  patch: { category?: ErrorCategory; reason?: string }
): void {
  const { position, actual } = tokenKey(token, sentence);
  const item = findQueueItem(queue, sentenceId, position, actual);
  if (item) Object.assign(item, patch);
}

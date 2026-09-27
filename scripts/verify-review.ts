// Ad-hoc verification of the review queue rules. Run with: npx tsx scripts/verify-review.ts
import {
  enqueueAttemptErrors,
  gradeReviewSentence,
  rebuildQueueFromHistory,
  syncClassificationToQueue,
  tokenPosition,
  type ContextLookup
} from '../src/review';
import type { PracticeAttempt } from '../src/types';
import { compareSentence } from '../src/utils';

const lookup: ContextLookup = (lessonId, sentenceId) => {
  if (lessonId !== 'l1') return undefined;
  return { courseId: 'c1', courseTitle: 'Course', lessonId: 'l1', lessonTitle: 'Lesson', translation: 't' };
};

const makeAttempt = (answer: string, source: string, id = 'a1'): PracticeAttempt => ({
  id,
  courseId: 'c1',
  lessonId: 'l1',
  courseTitle: 'Course',
  lessonTitle: 'Lesson',
  submittedAt: '2026-09-26T00:00:00.000Z',
  score: 0,
  teacherFeedback: 'keep me',
  sentenceAttempts: [{ sentenceId: 's1', source, answer, tokens: compareSentence(source, answer), score: 0 }]
});

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
};

// 1. Enqueue: wrong words collected by sentence + word position
const source = 'the quick brown fox jumps';
let queue = [] as any[];
const summary = enqueueAttemptErrors(queue, makeAttempt('the quik brown fox jump', source), lookup);
check('enqueue adds wrong words', summary.added === 2, `added=${summary.added}`);
check('queue keeps correct words out', queue.every((i) => i.expected !== 'the' && i.expected !== 'brown'));
check('queue carries origin course/sentence', queue[0].courseId === 'c1' && queue[0].sentenceId === 's1');

// 2. Re-submit same mistake: same item, streak/position preserved
queue[0].streak = 1;
const orderBefore = queue.map((i) => i.id);
const summary2 = enqueueAttemptErrors(queue, makeAttempt('the quik brown fox jump', source, 'a2'), lookup);
check('resubmit does not duplicate', summary2.added === 0 && queue.length === 2);
check('resubmit preserves streak', queue.find((i) => i.expected === 'quick').streak === 1);
check('resubmit preserves queue order', JSON.stringify(queue.map((i) => i.id)) === JSON.stringify(orderBefore));

// 3. Classification sync follows same sentence + word position
const sentenceForSync = makeAttempt('the quik brown fox jump', source).sentenceAttempts[0];
const quickToken = sentenceForSync.tokens.find((t) => t.expected === 'quick')!;
syncClassificationToQueue(queue, 's1', quickToken, sentenceForSync, { category: 'grammar', reason: 'r1' });
const quickItem = queue.find((i) => i.expected === 'quick');
check('category/reason sync to queued item', quickItem.category === 'grammar' && quickItem.reason === 'r1');

// 4. Review grading: correct once -> streak 1, still in queue; twice -> removed
//    (quick carries streak 1 from the resubmit-preservation check above.)
const s1 = gradeReviewSentence(queue, 's1', source, 'sess1', '2026-09-27T00:00:01Z');
check('first all-correct round: quick reaches 2 and leaves, jumps stays', s1.verdicts.every((v) => v.correct) && queue.length === 1 && queue[0].expected === 'jumps' && queue[0].streak === 1);
check('results recorded per word with removal flag', s1.results.length === 2 && s1.results.find((r) => r.expected === 'quick')?.removed && !s1.results.find((r) => r.expected === 'jumps')?.removed);
const s2 = gradeReviewSentence(queue, 's1', source, 'sess1', '2026-09-27T00:00:02Z');
check('second consecutive correct removes items', queue.length === 0 && s2.results.every((r) => r.removed));

// 5. Wrong answer resets streak and returns item to head
queue = [];
enqueueAttemptErrors(queue, makeAttempt('the quik brown fox jump', source), lookup);
enqueueAttemptErrors(queue, {
  ...makeAttempt('cat', 'dog', 'a9'),
  lessonId: 'l2',
  sentenceAttempts: [{ sentenceId: 's2', source: 'dog', answer: 'cat', tokens: compareSentence('dog', 'cat'), score: 0 }]
}, (lessonId) => lessonId === 'l2'
  ? { courseId: 'c1', courseTitle: 'Course', lessonId: 'l2', lessonTitle: 'L2', translation: '' }
  : lookup(lessonId, ''));
check('two sentences queued', new Set(queue.map((i) => i.sentenceId)).size === 2);
// make s1 quick item streak 1
const quick = queue.find((i) => i.sentenceId === 's1' && i.expected === 'quick')!;
quick.streak = 1;
const headBefore = queue[0].sentenceId;
const g = gradeReviewSentence(queue, 's1', 'the quik brown fox jumps', 'sess2', '2026-09-27T00:00:03Z');
check('wrong quick verdict detected', g.verdicts.find((v) => v.item.expected === 'quick')!.correct === false);
check('wrong answer resets streak', quick.streak === 0);
check('wrong word returned to queue head', queue[0].id === quick.id, `head was ${headBefore}`);

// 6. Only sentences with queued words are practised: s2 still present after s1 grading
check('other sentence untouched', queue.some((i) => i.sentenceId === 's2'));

// 7. History rebuild seeds v1 migration, newest classification wins
const old: PracticeAttempt = makeAttempt('the quik brown fox jumps', source, 'old');
old.submittedAt = '2026-09-20T00:00:00.000Z';
const newer: PracticeAttempt = makeAttempt('the quik brown fox jumps', source, 'new');
newer.submittedAt = '2026-09-22T00:00:00.000Z';
const quickNew = newer.sentenceAttempts[0].tokens.find((t) => t.expected === 'quick')!;
quickNew.category = 'spelling';
quickNew.reason = 'later edit';
const rebuilt = rebuildQueueFromHistory([newer, old], lookup);
const rebuiltQuick = rebuilt.find((i) => i.expected === 'quick')!;
check('history rebuild enqueues wrong words', rebuilt.length >= 1);
check('history rebuild keeps newest edit', rebuiltQuick.attemptId === 'new' && rebuiltQuick.reason === 'later edit');
check('legacy token position replays from source', tokenPosition(quickNew, newer.sentenceAttempts[0]) === 1);

// 8. Extra word (insert) handling
const extra = makeAttempt('hello there world', 'hello world', 'e1');
const q2 = [] as any[];
enqueueAttemptErrors(q2, extra, lookup);
const extraItem = q2.find((i) => i.tokenIndex === -1);
check('extra word queued at position -1', !!extraItem && extraItem.actual === 'there');
const g2 = gradeReviewSentence(q2, extraItem.sentenceId, 'hello world', 'sess3', '2026-09-27T00:00:04Z');
check('extra word absent => correct', g2.verdicts.find((v) => v.item.tokenIndex === -1)!.correct);
const g3 = gradeReviewSentence(q2, extraItem.sentenceId, 'hello world', 'sess3', '2026-09-27T00:00:05Z');
check('extra word removed after two clean answers', !q2.some((i) => i.tokenIndex === -1) && g3.results.length === 1);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);

import type { SentenceAttempt, TextSegment, TokenResult } from './types';

export const segmentText = (text: string): TextSegment[] => {
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]+/gu) ?? [];
  return matches.map((display, index) => ({
    index,
    display,
    normalized: normalizeToken(display)
  }));
};

export const normalizeToken = (token: string): string => token
  .toLocaleLowerCase('en')
  .replaceAll('’', "'")
  .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

export function compareSentence(expected: string, answer: string): TokenResult[] {
  const expectedTokens = segmentText(expected);
  const actualTokens = segmentText(answer);
  const rows = expectedTokens.length + actualTokens.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(rows + 1).fill(0));
  const move = Array.from({ length: rows + 1 }, () => Array<string>(rows + 1).fill(''));

  for (let i = 0; i <= expectedTokens.length; i += 1) {
    table[i][0] = i;
    move[i][0] = 'delete';
  }
  for (let j = 0; j <= actualTokens.length; j += 1) {
    table[0][j] = j;
    move[0][j] = 'insert';
  }

  for (let i = 1; i <= expectedTokens.length; i += 1) {
    for (let j = 1; j <= actualTokens.length; j += 1) {
      const substitution = table[i - 1][j - 1] + (expectedTokens[i - 1].normalized === actualTokens[j - 1].normalized ? 0 : 1);
      const deletion = table[i - 1][j] + 1;
      const insertion = table[i][j - 1] + 1;
      table[i][j] = Math.min(substitution, deletion, insertion);
      move[i][j] = substitution <= deletion && substitution <= insertion
        ? 'match'
        : deletion <= insertion ? 'delete' : 'insert';
    }
  }

  const reversed: TokenResult[] = [];
  let i = expectedTokens.length;
  let j = actualTokens.length;
  while (i > 0 || j > 0) {
    const direction = move[i][j];
    if (direction === 'match' && i > 0 && j > 0) {
      const expectedToken = expectedTokens[i - 1];
      const actualToken = actualTokens[j - 1];
      const correct = expectedToken.normalized === actualToken.normalized;
      reversed.push({
        index: i - 1,
        expected: expectedToken.display,
        actual: actualToken.display,
        correct,
        category: correct ? 'unclassified' : 'spelling',
        reason: ''
      });
      i -= 1;
      j -= 1;
    } else if (direction === 'delete' && i > 0) {
      reversed.push({ index: i - 1, expected: expectedTokens[i - 1].display, actual: '', correct: false, category: 'omitted', reason: '' });
      i -= 1;
    } else if (j > 0) {
      reversed.push({ index: Math.max(0, i - 1), expected: '', actual: actualTokens[j - 1].display, correct: false, category: 'extra', reason: '' });
      j -= 1;
    } else {
      break;
    }
  }

  const result = reversed.reverse();
  return result.map((token, index) => ({ ...token, index }));
}

/**
 * 按 compareSentence 的回溯方向，为每个结果词计算“稳定词位”：
 * - 原文词（含拼写、漏词、标点）→ 原文词索引，跨重交不受对齐方式影响；
 * - 多词项 → 锚点词位（前一个原文词索引），配合实际词形区分同一锚点的多词。
 */
export function stableTokenPositions(expected: string, answer: string): Array<{ position: number; anchorActual: string }> {
  const expectedTokens = segmentText(expected);
  const actualTokens = segmentText(answer);
  const rows = expectedTokens.length + actualTokens.length;
  const table = Array.from({ length: rows + 1 }, () => Array<number>(rows + 1).fill(0));
  const move = Array.from({ length: rows + 1 }, () => Array<string>(rows + 1).fill(''));

  for (let i = 0; i <= expectedTokens.length; i += 1) {
    table[i][0] = i;
    move[i][0] = 'delete';
  }
  for (let j = 0; j <= actualTokens.length; j += 1) {
    table[0][j] = j;
    move[0][j] = 'insert';
  }

  for (let i = 1; i <= expectedTokens.length; i += 1) {
    for (let j = 1; j <= actualTokens.length; j += 1) {
      const substitution = table[i - 1][j - 1] + (expectedTokens[i - 1].normalized === actualTokens[j - 1].normalized ? 0 : 1);
      const deletion = table[i - 1][j] + 1;
      const insertion = table[i][j - 1] + 1;
      table[i][j] = Math.min(substitution, deletion, insertion);
      move[i][j] = substitution <= deletion && substitution <= insertion
        ? 'match'
        : deletion <= insertion ? 'delete' : 'insert';
    }
  }

  const reversed: Array<{ position: number; anchorActual: string }> = [];
  let i = expectedTokens.length;
  let j = actualTokens.length;
  while (i > 0 || j > 0) {
    const direction = move[i][j];
    if (direction === 'match' && i > 0 && j > 0) {
      reversed.push({ position: i - 1, anchorActual: '' });
      i -= 1;
      j -= 1;
    } else if (direction === 'delete' && i > 0) {
      reversed.push({ position: i - 1, anchorActual: '' });
      i -= 1;
    } else if (j > 0) {
      reversed.push({ position: Math.max(0, i - 1), anchorActual: actualTokens[j - 1].display });
      j -= 1;
    } else {
      break;
    }
  }
  return reversed.reverse();
}

export function scoreAttempt(sentenceAttempts: SentenceAttempt[]): number {
  const totals = sentenceAttempts.flatMap((attempt) => attempt.tokens);
  if (!totals.length) return 0;
  const correct = totals.filter((token) => token.correct).length;
  return Math.max(0, Math.round((correct / totals.length) * 100));
}

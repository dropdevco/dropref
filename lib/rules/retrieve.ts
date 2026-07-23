import type { SportCorpus, SportRule } from '@/types/contract';

/**
 * OWNER: Dev B (AI pipeline).
 *
 * WHAT IT MUST DO:
 *   Rank the corpus's rules against a free-text `query` (typically the
 *   observation of what happened in the clip) using Fuse.js. Weight the
 *   fields: keywords (weight 3), title (weight 2), text (weight 1).
 *   `k` caps how many rules are returned (default sensible, e.g. 4).
 *   No sport-specific logic — this operates purely on the passed corpus.
 *
 * WHAT IT MUST RETURN:
 *   The top-`k` best-matching `SportRule[]`, most relevant first. Never
 *   more than the corpus contains; may return fewer.
 */
export function retrieveRules(
  _corpus: SportCorpus,
  _query: string,
  _k = 4,
): SportRule[] {
  throw new Error('NOT_IMPLEMENTED: Dev B');
}

import Fuse from 'fuse.js';
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
 *
 * NOTE (Dev A, at owner's request): switched from a single whole-query Fuse
 * search to a TOKENISED search. Feeding Fuse a long natural-language sentence
 * scores it as one pattern against short keyword strings, so the right rule
 * (e.g. a foul rule whose keyword is "tackle") drops below threshold for
 * verbose descriptions. Now we search the whole query AND each significant
 * term, then sum each rule's relevance across all searches — so a rule matched
 * by many query words (contact point, body part, action) outranks one matched
 * by a single incidental word. Same signature, same field weights, still Fuse.
 */

/** Common words that carry no retrieval signal — skipped when tokenising. */
const STOPWORDS = new Set([
  'the', 'and', 'was', 'were', 'with', 'from', 'that', 'this', 'then', 'they',
  'their', 'for', 'are', 'has', 'have', 'had', 'not', 'but', 'you', 'his',
  'her', 'she', 'him', 'who', 'onto', 'into', 'out', 'off', 'over', 'under',
  'when', 'where', 'while', 'which', 'before', 'after', 'been', 'being', 'its',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'it', 'is', 'as', 'by', 'or', 'be',
]);

/** Split a query into distinct, meaningful lowercase terms. */
function tokenize(query: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 2 && !STOPWORDS.has(w) && !seen.has(w)) {
      seen.add(w);
      terms.push(w);
    }
  }
  return terms;
}

export function retrieveRules(
  corpus: SportCorpus,
  query: string,
  k = 4,
): SportRule[] {
  if (!query || query.trim() === '') {
    return corpus.rules.slice(0, k);
  }

  const fuse = new Fuse(corpus.rules, {
    keys: [
      { name: 'keywords', weight: 3 },
      { name: 'title', weight: 2 },
      { name: 'text', weight: 1 },
    ],
    threshold: 0.5,
    ignoreLocation: true,
    includeScore: true,
  });

  // The whole query preserves phrase/short-query matches; the per-term searches
  // let individual words in a long description each find their rule.
  const patterns = [query, ...tokenize(query)];

  const agg = new Map<string, { rule: SportRule; score: number; hits: number }>();
  for (const pattern of patterns) {
    for (const { item, score } of fuse.search(pattern)) {
      // Fuse score: 0 = perfect … 1 = worst → convert to positive relevance.
      const relevance = 1 - (score ?? 1);
      const prev = agg.get(item.code);
      if (prev) {
        prev.score += relevance;
        prev.hits += 1;
      } else {
        agg.set(item.code, { rule: item, score: relevance, hits: 1 });
      }
    }
  }

  return [...agg.values()]
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .slice(0, k)
    .map((e) => e.rule);
}

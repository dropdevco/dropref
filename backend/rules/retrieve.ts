import Fuse from 'fuse.js';
import { SportCorpus, CitedRule, SportRule } from '../../types/contract';

/**
 * Tokenised retrieval. Feeding Fuse a whole natural-language description as one
 * pattern scores poorly against short keyword strings, so the applicable rule
 * (e.g. a foul rule keyed on "tackle") can drop below threshold for verbose
 * descriptions — the exact "extract keywords first" TODO noted here previously.
 * Instead we search the whole query AND each significant term, then sum each
 * rule's relevance across all searches, so a rule matched by many words in the
 * description outranks one matched by a single incidental word.
 * Same signature and return type (CitedRule[]).
 */

const STOPWORDS = new Set([
  'the', 'and', 'was', 'were', 'with', 'from', 'that', 'this', 'then', 'they',
  'their', 'for', 'are', 'has', 'have', 'had', 'not', 'but', 'you', 'his',
  'her', 'she', 'him', 'who', 'onto', 'into', 'out', 'off', 'over', 'under',
  'when', 'where', 'while', 'which', 'before', 'after', 'been', 'being', 'its',
  'a', 'an', 'of', 'to', 'in', 'on', 'at', 'it', 'is', 'as', 'by', 'or', 'be',
]);

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
  description: string,
  maxResults: number = 5,
): CitedRule[] {
  if (!description || description.trim() === '') {
    return corpus.rules.slice(0, maxResults).map((r) => ({
      code: r.code,
      title: r.title,
      text: r.text,
    }));
  }

  const fuse = new Fuse(corpus.rules, {
    keys: [
      { name: 'keywords', weight: 3 },
      { name: 'title', weight: 2 },
      { name: 'text', weight: 1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
    includeScore: true,
  });

  // Whole query preserves phrase/short-query matches; per-term searches let
  // individual words in a long description each find their rule.
  const patterns = [description, ...tokenize(description)];
  const agg = new Map<
    string,
    { rule: SportRule; score: number; hits: number }
  >();
  for (const pattern of patterns) {
    for (const { item, score } of fuse.search(pattern)) {
      const relevance = 1 - (score ?? 1); // Fuse score: 0 best … 1 worst
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
    .slice(0, maxResults)
    .map((e) => ({
      code: e.rule.code,
      title: e.rule.title,
      text: e.rule.text,
    }));
}

export function filterValidRuleCodes(corpus: SportCorpus, codes: string[]): string[] {
  const validCodes = new Set(corpus.rules.map((r: SportRule) => r.code));
  const filtered = codes.filter((code) => {
    if (validCodes.has(code)) return true;
    console.warn(`[RefCheck AI] Model cited invalid rule code: ${code}`);
    return false;
  });
  return filtered;
}

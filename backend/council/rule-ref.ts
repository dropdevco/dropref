import type { SportCorpus, SportRule } from '../../types/contract';

/**
 * Stable, UNIQUE reference for a rule.
 *
 * `SportRule.code` is NOT unique: soccer's corpus alone reuses "Law 12.1" for
 * five distinct rules (careless / reckless / excessive force / handball /
 * holding) and "Law 11.2" for two. Every consumer that keys by `code` — the
 * `Set` in filterValidRuleCodes, the `Map` in citeRules — silently collapses
 * those into whichever entry it saw last, so a model that correctly identifies
 * "reckless challenge" can have its citation resolved to "handball".
 *
 * The ref appends a slug of the title, which IS distinguishing, and is what we
 * put in prompts and in golden-set labels. It is derived, so no corpus file
 * has to change and the frozen contract stays intact.
 */
export function ruleRef(rule: Pick<SportRule, 'code' | 'title'>): string {
  const slug = rule.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${rule.code} :: ${slug}`;
}

/** Human-facing label used inside prompts, e.g. "[Law 12.1 :: reckless-challenge-yellow-card] …". */
export function ruleRefsFor(corpus: SportCorpus): Map<string, SportRule> {
  return new Map(corpus.rules.map((r) => [ruleRef(r), r]));
}

/** True when a corpus contains codes shared by more than one rule. */
export function findDuplicateCodes(corpus: SportCorpus): string[] {
  const seen = new Map<string, number>();
  for (const r of corpus.rules) seen.set(r.code, (seen.get(r.code) ?? 0) + 1);
  return Array.from(seen.entries()).filter(([, n]) => n > 1).map(([c]) => c);
}

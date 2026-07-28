import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { SportCorpus, SportId } from '../types/contract';

/**
 * Runtime shape of a corpus file.
 *
 * `SportRule.source` is declared required in the contract, but the corpus
 * arrives via `JSON.parse` — a cast, not a check. Without this schema, deleting
 * a `source` from any of the rule JSONs produces zero tsc errors and zero
 * runtime errors: the rule simply flows through to the UI with
 * `CitedRule.source === undefined`, `RuleSourceLink` returns null, and the
 * citation silently ships with no link to the official rulebook. That is the
 * one failure mode this feature exists to prevent, so it fails loudly instead.
 */
const ruleSourceSchema = z.object({
  // Only http(s): a corpus URL is rendered straight into an anchor `href`.
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), {
    message: 'source.url must be an http(s) URL',
  }),
  publisher: z.string().min(1),
  label: z.string().min(1),
});

const sportRuleSchema = z.object({
  code: z.string().min(1),
  title: z.string().min(1),
  text: z.string().min(1),
  keywords: z.array(z.string()),
  callTypes: z.array(z.string()),
  needsVerification: z.boolean().optional(),
  source: ruleSourceSchema,
});

const sportCorpusSchema = z.object({
  id: z.enum(['soccer', 'football', 'lacrosse']),
  displayName: z.string().min(1),
  governingBody: z.string().min(1),
  officialTitle: z.string().min(1),
  analystPersona: z.string().min(1),
  observationHints: z.string(),
  commonCalls: z.array(z.string()),
  rules: z.array(sportRuleSchema).min(1),
});

export function getSportCorpus(id: SportId): SportCorpus {
  const filePath = path.join(process.cwd(), 'backend', 'data', 'sports', `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Corpus for sport ${id} not found.`);
  }
  const fileContents = fs.readFileSync(filePath, 'utf8');
  const parsed = sportCorpusSchema.safeParse(JSON.parse(fileContents));
  if (!parsed.success) {
    // Point at the offending rule; `issues[0].path` is e.g. rules.7.source.url.
    const issue = parsed.error.issues[0];
    throw new Error(
      `Corpus for sport ${id} is invalid at "${issue.path.join('.')}": ${issue.message}`,
    );
  }
  return parsed.data as SportCorpus;
}

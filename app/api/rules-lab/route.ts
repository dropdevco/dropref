import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getSportCorpus } from '@/backend/sports';
import { retrieveRules } from '@/backend/rules/retrieve';
import {
  adjudicate,
  isAdjudicationAvailable,
  lastModelUsed,
  type LabResult,
} from '@/lib/lab/adjudicate';
import type { SportId, SportRule } from '@/types/contract';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * OWNER: Dev A (frontend) — DEV/TEST TOOL, not part of the product flow.
 *
 * POST /api/rules-lab  { sport, query, originalCall?, k? }
 *   Runs the decision pipeline on a supplied description, skipping the video +
 *   AI-description step:
 *     1. RETRIEVE — retrieveRules(getSportCorpus(sport), query, k) → candidates.
 *     2. ADJUDICATE — the LLM picks the applicable rule(s) and returns a verdict
 *        or ruling. Requires OPENROUTER_API_KEY / GEMINI_API_KEY; without it we
 *        return retrieval candidates only.
 *
 * Uses Dev B's backend/ pipeline (getSportCorpus, retrieveRules) after they
 * relocated it from lib/ to backend/.
 */

const SPORT_IDS = ['soccer', 'football', 'lacrosse'] as const;

const bodySchema = z.object({
  sport: z.enum(SPORT_IDS),
  query: z.string().trim().min(1, 'Enter a description to test.').max(2000),
  originalCall: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  k: z.number().int().min(1).max(12).optional().default(6),
});

export interface RulesLabResponse {
  sport: SportId;
  displayName: string;
  totalRules: number;
  query: string;
  originalCall: string | null;
  k: number;
  /** The retrieval shortlist (recall step). */
  matches: SportRule[];
  /** True when an adjudication key is configured and adjudication ran. */
  adjudicationAvailable: boolean;
  /**
   * The precision step, or null when adjudication is unavailable/failed.
   * `mode: 'verdict'` when a call was supplied, `mode: 'ruling'` when the AI
   * made the call itself (no referee call given).
   */
  result: LabResult | null;
  /** The model that produced the result, if any. */
  modelUsed?: string;
  /** Populated when adjudication was available but errored. */
  adjudicationError?: string;
}

export interface RulesLabError {
  error: string;
}

/** Turn a raw provider error into one concise, actionable line for the UI. */
function friendlyAdjudicationError(msg: string): string {
  if (/\b402\b|insufficient|no credits|requires more credits/i.test(msg)) {
    return 'OpenRouter: this model needs credits your account doesn’t have. Add credits at openrouter.ai, or set OPENROUTER_MODEL to a model you can access.';
  }
  if (/\b401\b|invalid api key|no auth|unauthor|user not found/i.test(msg)) {
    return 'The OPENROUTER_API_KEY was rejected (invalid or unauthorized). Check the key in .env.';
  }
  if (/429|too many requests|quota|rate limit/i.test(msg)) {
    return 'Rate limit / quota exceeded for this key and model. Wait a moment and retry, or set OPENROUTER_MODEL / GEMINI_MODEL to a model with available quota.';
  }
  if (/api[_ ]?key not valid|api_key_invalid|permission denied/i.test(msg)) {
    return 'The GEMINI_API_KEY was rejected (invalid or unauthorized). Double-check the key in .env.';
  }
  if (/no usable model|did not return valid json/i.test(msg)) {
    return msg; // already concise + actionable
  }
  return msg.length > 240 ? msg.slice(0, 240).trimEnd() + '…' : msg;
}

export async function POST(request: Request) {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json<RulesLabError>(
      { error: 'Body must be JSON.' },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json<RulesLabError>(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { sport, query, originalCall, k } = parsed.data;

  let corpus;
  let matches: SportRule[];
  try {
    corpus = getSportCorpus(sport);
    // backend/retrieveRules returns CitedRule[] (code/title/text); map codes
    // back to the full SportRule (keywords/callTypes) for the lab's display
    // and to pass rich candidates to the adjudicator.
    const byCode = new Map(corpus.rules.map((r) => [r.code, r]));
    matches = retrieveRules(corpus, query, k)
      .map((c) => byCode.get(c.code))
      .filter((r): r is SportRule => Boolean(r));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Retrieval failed unexpectedly.';
    return NextResponse.json<RulesLabError>({ error: message }, { status: 500 });
  }

  const available = isAdjudicationAvailable();
  let result: LabResult | null = null;
  let adjudicationError: string | undefined;

  if (available && matches.length > 0) {
    try {
      result = await adjudicate({
        sport,
        displayName: corpus.displayName,
        observation: query,
        originalCall,
        candidates: matches,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Adjudication failed.';
      adjudicationError = friendlyAdjudicationError(raw);
    }
  }

  return NextResponse.json<RulesLabResponse>({
    sport,
    displayName: corpus.displayName,
    totalRules: corpus.rules.length,
    query,
    originalCall,
    k,
    matches,
    adjudicationAvailable: available,
    result,
    ...(result ? { modelUsed: lastModelUsed() ?? undefined } : {}),
    ...(adjudicationError ? { adjudicationError } : {}),
  });
}

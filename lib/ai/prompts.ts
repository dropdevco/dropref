import type { SportCorpus, SportRule } from '@/types/contract';

/**
 * OWNER: Dev B (AI pipeline).
 *
 * WHAT THIS FILE MUST DO:
 *   Provide EXACTLY ONE prompt template per pipeline stage. All sport-specific
 *   wording is interpolated from the `SportCorpus` (displayName, governingBody,
 *   officialTitle, analystPersona, observationHints, commonCalls, rules...).
 *   There must be NO per-sport branching (`if (sport === 'soccer')`) anywhere —
 *   a new sport is a new JSON corpus and these templates must already cover it.
 */

/**
 * Stage 1 — observation.
 * Returns a single prompt string instructing the model to describe, neutrally,
 * only what is observable (driven by the corpus's analystPersona /
 * observationHints / commonCalls). No verdict at this stage.
 *
 * NOTE (Dev A, at owner's request): drafted this template to close a retrieval
 * gap — free-text descriptions like "slid in and caught his ankle" don't
 * lexically match rulebook keywords ("tackle", "trip"), so the applicable rule
 * never gets retrieved. The fix is to make the description speak the rulebook's
 * language: it directs the model to use officiating terminology and name the
 * likely offence from the sport's own `commonCalls`. Fully corpus-driven, no
 * per-sport branching. Dev B: keep or adapt when wiring the pipeline.
 */
export function observationPrompt(corpus: SportCorpus): string {
  const vocabulary = corpus.commonCalls.join(', ');
  return `You are ${corpus.analystPersona}. Watch the clip and describe, in neutral and factual language, ONLY what is observable. Do NOT give a verdict, opinion, or ruling — a later step decides that.

Focus your observation on: ${corpus.observationHints}

Describe the mechanics precisely enough to be matched against the ${corpus.displayName} rulebook:
- the specific action and the body parts / equipment involved, and the exact contact point;
- the timing relative to the ball (before or after the ball was played or touched);
- the players' positions and their direction and speed of movement;
- the degree of control and intensity of any contact.

Use standard ${corpus.displayName} officiating terminology. When an action resembles a recognised offence, name it using the sport's own vocabulary (for ${corpus.displayName}: ${vocabulary}). Prefer the words an official and the written Laws would use — e.g. "a reckless slide tackle that trips the opponent before the ball is played", not "he slid in and caught the guy's leg" — so the description can be reliably matched to the rulebook.

Respond with 2–4 sentences of neutral description only.`;
}

/** Inputs to the stage-2 adjudication template. */
export interface AdjudicationArgs {
  corpus: SportCorpus;
  /** The neutral observation produced by stage 1. */
  observation: string;
  /** Candidate rules retrieved for this play. */
  rules: SportRule[];
  /** What the referee actually called on the field, if provided. */
  originalCall: string | null;
}

/**
 * Stage 2 — adjudication.
 * MUST RETURN: a single prompt string that gives the model the observation,
 * the retrieved rules, and the original call, and asks it to return a verdict
 * (FAIR_CALL / BAD_CALL / INCONCLUSIVE), confidence, reasoning, and the rules
 * it relied on — shaped so the route can build an `AnalyzeResponse`.
 */
export function adjudicationPrompt(_args: AdjudicationArgs): string {
  throw new Error('NOT_IMPLEMENTED: Dev B');
}

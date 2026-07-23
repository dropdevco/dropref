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
 * MUST RETURN: a single prompt string that instructs the model to watch the
 * clip and describe, neutrally, only what is observable (using the corpus's
 * analystPersona and observationHints). No verdict at this stage.
 */
export function observationPrompt(_corpus: SportCorpus): string {
  throw new Error('NOT_IMPLEMENTED: Dev B');
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

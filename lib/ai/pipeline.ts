import type { AnalyzeResponse, SportId } from '@/types/contract';

/**
 * OWNER: Dev B (AI pipeline).
 *
 * WHAT IT MUST DO (two stages):
 *   1. OBSERVE — send the video to Gemini with `observationPrompt(corpus)` and
 *      get a neutral description of what happened in the clip.
 *   2. RETRIEVE + ADJUDICATE — feed that observation to `retrieveRules()` to
 *      pull candidate rules, then call the model with `adjudicationPrompt(...)`
 *      to produce the verdict, confidence, reasoning, and cited rules.
 *   Load the corpus via `getSport(sport)`. Time the whole run for `processingMs`.
 *
 * WHAT IT MUST RETURN:
 *   A complete `AnalyzeResponse` matching the frozen contract. Throw on model
 *   failure/timeout — the route maps thrown errors to the appropriate ErrorCode.
 */
export async function analyze(
  _video: File,
  _sport: SportId,
  _originalCall: string | null,
): Promise<AnalyzeResponse> {
  throw new Error('NOT_IMPLEMENTED: Dev B');
}

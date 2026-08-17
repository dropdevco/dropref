import { z } from 'zod';
import { getSportCorpus } from '../sports';
import { retrieveRules, filterValidRuleCodes } from '../rules/retrieve';
import { buildObservationPrompt, buildAdjudicationPrompt } from './prompts';
import { adjudicateText, extractJson, observePlay } from './vision';
import { AnalyzeResponse, SportId } from '../../types/contract';

/**
 * BASELINE arm: one vision call, one adjudication call, no checking of either.
 *
 * Deliberately kept after the graph landed (backend/graph/run.ts). It is the
 * control the graph is measured against, and an A/B with no control arm is a
 * press release. The transport now lives in ./vision.ts so both arms share it.
 */

// Zod schema for model output validation
const AdjudicationSchema = z.object({
  verdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  reasoning: z.string(),
  ruleCodes: z.array(z.string()),
});

async function adjudicatePlay(prompt: string): Promise<z.infer<typeof AdjudicationSchema>> {
  const text = await adjudicateText(prompt);
  return AdjudicationSchema.parse(JSON.parse(extractJson(text)));
}

export async function runAnalysisPipeline(
  sportId: SportId,
  videoBase64: string,
  videoMimeType: string,
  skeletonBase64: string | null = null,
  originalCall: string | null = null,
  cvMetadata: any = null,
  keyFramesBase64: string[] | null = null
): Promise<AnalyzeResponse> {
  const startTime = Date.now();

  // 1. Load corpus
  const corpus = getSportCorpus(sportId);

  // --- STAGE 1: Observation ---
  const obsPrompt = buildObservationPrompt(corpus, originalCall, cvMetadata);
  const playDescription = await observePlay({
    prompt: obsPrompt,
    videoBase64,
    videoMimeType,
    skeletonBase64,
    keyFramesBase64,
  });

  // --- STAGE 2: Adjudication ---
  const searchQuery = originalCall ? `${originalCall} ${playDescription}` : playDescription;
  const retrievedRules = retrieveRules(corpus, searchQuery, 5);
  const adjPrompt = buildAdjudicationPrompt(corpus, playDescription, originalCall, retrievedRules);

  // Try parsing the result, with 1 retry on failure
  let adjudicationData;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      adjudicationData = await adjudicatePlay(adjPrompt);
      break;
    } catch (e) {
      if (attempts === 2) {
        // Fallback on total failure
        adjudicationData = {
          verdict: 'INCONCLUSIVE' as const,
          confidence: 'LOW' as const,
          reasoning: 'Failed to generate a valid response after multiple attempts.',
          ruleCodes: []
        };
      }
    }
  }

  // Filter out any hallucinated rule codes server-side
  const validRuleCodes = filterValidRuleCodes(corpus, adjudicationData!.ruleCodes);

  const rulesCited = retrievedRules.filter(r => validRuleCodes.includes(r.code));

  const processingMs = Date.now() - startTime;

  return {
    sport: sportId,
    verdict: adjudicationData!.verdict,
    confidence: adjudicationData!.confidence,
    playDescription,
    reasoning: adjudicationData!.reasoning,
    rulesCited,
    originalCall,
    processingMs
  };
}

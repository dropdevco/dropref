import { z } from 'zod';
import type { Confidence, Verdict } from '../../types/contract';
import { normalizeProbability } from './agreement';
import { councilChatJson } from './client';
import { coerceProbability } from './panel';
import { buildChairPrompt, filterValidRuleRefs } from './prompts';
import type {
  CouncilConfig,
  CouncilInput,
  DebateStatement,
  PanelOpinion,
} from './types';

/** Stage 3: a stronger model reads the whole transcript and settles it. */

export const ChairResponseSchema = z.object({
  verdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  selfProbability: z.union([z.number(), z.string()]).nullish(),
  reasoning: z.string().min(1),
  rationale: z.string().nullish(),
  citedRuleRefs: z.array(z.string()).nullish(),
});

export interface ChairRuling {
  verdict: Verdict;
  confidence: Confidence;
  selfProbability: number;
  reasoning: string;
  /** Which seat the chair found decisive — surfaced as `chairRationale`. */
  rationale: string;
  citedRuleRefs: string[];
  latencyMs: number;
  calls: number;
}

export async function runChair(
  input: CouncilInput,
  config: CouncilConfig,
  opinions: PanelOpinion[],
  debate: DebateStatement[],
  signal: AbortSignal,
): Promise<ChairRuling> {
  const { system, user } = buildChairPrompt(input, config.chair, opinions, debate);
  const { value, latencyMs, calls } = await councilChatJson(
    { seat: config.chair, system, user, signal, maxTokens: 1200 },
    ChairResponseSchema,
  );

  return {
    verdict: value.verdict,
    confidence: value.confidence,
    selfProbability: normalizeProbability(
      coerceProbability(value.selfProbability),
      value.confidence,
    ),
    reasoning: value.reasoning,
    rationale: value.rationale?.trim() || value.reasoning,
    citedRuleRefs: filterValidRuleRefs(value.citedRuleRefs ?? [], input.candidates),
    latencyMs,
    calls,
  };
}

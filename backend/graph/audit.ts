import { z } from 'zod';
import type { SportRule } from '../../types/contract';
import { councilChatJson } from '../council/client';
import { renderCandidates } from '../council/prompts';
import type { CouncilResult } from '../council/types';
import type { GraphConfig } from './models';
import { pseudoSeat } from './models';
import type { AuditResult, ObservationBundle } from './types';

/**
 * The evidence auditor: the one node whose job is to attack the answer.
 *
 * WHY IT IS NOT A FOURTH SEAT. As a seat it would cast one more vote and be
 * averaged into the same consensus number the other seats produced — a critic
 * with a ballot is just another voter. Placed downstream of the ruling it can
 * attack the ACTUAL claim the system is about to make, including the chair's,
 * and its findings can penalise a verdict without changing what that verdict is.
 *
 * WHY IT RETURNS FINDINGS AND NOT A SCORE. Asking a model for its own penalty
 * multiplier gets you a vibe on an invented scale. The auditor enumerates which
 * claims the observation supports and which it does not; `score.ts` turns that
 * into a number in code, where the arithmetic is inspectable and testable.
 *
 * The auditor must run on a model that produced no part of the answer — see
 * `auditorModel()` in ./models.ts.
 */

export const AuditResponseSchema = z.object({
  supportedClaims: z.array(z.string()).nullish(),
  unsupportedClaims: z.array(z.string()).nullish(),
  ruleMisuse: z.array(z.string()).nullish(),
  overreach: z.union([z.boolean(), z.string()]).nullish(),
  notes: z.string().nullish(),
});

/** Models emit "true"/"yes"/1 about as often as a real boolean. */
export function coerceBoolean(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return /^(1|true|yes|y)$/i.test(raw.trim());
  return false;
}

function buildAuditPrompt(
  observation: ObservationBundle,
  council: CouncilResult,
  candidates: SportRule[],
  displayName: string,
): { system: string; user: string } {
  const contested =
    observation.contested.length > 0
      ? observation.contested.map((c) => `- ${c}`).join('\n')
      : '(the observers agreed on every decisive fact, or only one observer ran)';

  const cited =
    council.rulesCited.length > 0
      ? council.rulesCited.map((r) => `- [${r.code}] ${r.title}`).join('\n')
      : '(no rule was cited)';

  return {
    system: `You are an EVIDENCE AUDITOR reviewing a ${displayName} officiating decision that has already been made.

You are NOT deciding the case. You did not take part in reaching this verdict and you must not restate,
re-argue or replace it. Your only question is whether the stated reasoning is entitled to the evidence it
rests on.

Check three things, in this order:
1. CLAIMS. Break the reasoning into the factual claims it depends on. For each, decide whether the
   OBSERVATION establishes it. A claim that is merely plausible, typical of the sport, or inferred from
   what "usually" happens is NOT established. A claim resting on a fact listed as contested is NOT
   established.
2. RULES. For each cited rule, decide whether it actually governs the play as described. A rule that is
   topically related but whose conditions the observation never satisfies is misuse.
3. OVERREACH. Set "overreach" true when the verdict is stated more firmly than the surviving evidence
   permits — most commonly a confident FAIR_CALL or BAD_CALL resting on a contested or unestablished fact
   where INCONCLUSIVE was available.

Discipline:
- Judge only against the observation and the candidate rules shown. You cannot see the video.
- Do not invent doubt. A claim the observation states plainly is supported, even if you would have
  described it differently.
- An answer with nothing wrong with it is a normal outcome: return empty "unsupportedClaims" and
  "ruleMisuse" and overreach false. An auditor that always finds something is not auditing.`,
    user: `OBSERVATION (all the visual evidence that exists):
${observation.observation}

FACTS THE OBSERVERS COULD NOT AGREE ON:
${contested}

CANDIDATE RULES:
${renderCandidates(candidates)}

THE DECISION UNDER AUDIT:
  verdict: ${council.verdict} (stated confidence ${council.confidence})
  settled at stage: ${council.stage}
  cites:
${cited}
  reasoning: ${council.reasoning}

Return ONLY this JSON object:
{
  "supportedClaims": ["each factual claim the observation DOES establish"],
  "unsupportedClaims": ["each factual claim the observation does NOT establish"],
  "ruleMisuse": ["each cited rule that does not govern this play, with one clause saying why"],
  "overreach": false,
  "notes": "1-3 sentences on the single weakest point in the decision"
}`,
  };
}

/**
 * Run the auditor on its own deadline.
 *
 * A dead auditor is NOT a dead request and it is NOT a clean bill of health:
 * `failed` is set, `score.ts` applies no penalty (it has no findings to apply
 * one from), and the human gate fires on the failure instead. An unchecked
 * answer must never ship as TRUSTWORTHY, but it should still ship.
 */
export async function runAudit(
  observation: ObservationBundle,
  council: CouncilResult,
  candidates: SportRule[],
  displayName: string,
  config: GraphConfig,
): Promise<AuditResult> {
  const started = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.auditTimeoutMs);
  const seat = pseudoSeat('auditor', config.auditor, 0.1);

  try {
    const { system, user } = buildAuditPrompt(observation, council, candidates, displayName);
    const { value, model, calls } = await councilChatJson(
      { seat, system, user, signal: controller.signal, maxTokens: 1100 },
      AuditResponseSchema,
    );

    const clean = (xs: string[] | null | undefined): string[] =>
      (xs ?? []).map((x) => x.trim()).filter((x) => x !== '');

    return {
      supportedClaims: clean(value.supportedClaims),
      unsupportedClaims: clean(value.unsupportedClaims),
      ruleMisuse: clean(value.ruleMisuse),
      overreach: coerceBoolean(value.overreach),
      notes: (value.notes ?? '').trim(),
      model,
      failed: false,
      latencyMs: Date.now() - started,
      calls,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Graph] auditor failed; the answer ships UNCHECKED: ${message}`);
    return {
      supportedClaims: [],
      unsupportedClaims: [],
      ruleMisuse: [],
      overreach: false,
      notes: '',
      model: seat.model,
      failed: true,
      error: message,
      latencyMs: Date.now() - started,
      calls: 1,
    };
  } finally {
    clearTimeout(deadline);
  }
}

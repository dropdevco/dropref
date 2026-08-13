import { z } from 'zod';
import { normalizeProbability } from './agreement';
import { councilChatJson } from './client';
import { coerceProbability } from './panel';
import {
  anonymiseOpinions,
  buildDebatePrompt,
  filterValidRuleRefs,
  seatLabels,
} from './prompts';
import type { Confidence } from '../../types/contract';
import type {
  CouncilConfig,
  CouncilInput,
  CouncilRole,
  DebateStatement,
  PanelOpinion,
} from './types';
import type { VerdictSample } from './agreement';

/** Stage 2: each seat critiques the anonymised spread and may revise. */

export const DebateResponseSchema = z.object({
  revisedVerdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  revisedConfidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  revisedProbability: z.union([z.number(), z.string()]).nullish(),
  critique: z.string().min(1),
  citedRuleRefs: z.array(z.string()).nullish(),
  changedMind: z.boolean().nullish(),
});

export interface DebateRunResult {
  statements: DebateStatement[];
  /** Seats that returned in round 1 but failed to critique in round 2. */
  failedSeats: string[];
  totalCalls: number;
}

/**
 * Debate only the seats that produced a usable opinion, again in parallel.
 *
 * A seat that fails here is NOT dropped from the council: its round-1 opinion
 * still stands and still counts, because losing a critique is not evidence that
 * its original reasoning was wrong.
 */
export async function runDebate(
  input: CouncilInput,
  config: CouncilConfig,
  opinions: PanelOpinion[],
  signal: AbortSignal,
): Promise<DebateRunResult> {
  const labels = seatLabels(opinions);
  const seatsById = new Map(config.seats.map((s) => [s.id, s]));
  const participants = opinions.filter((o) => seatsById.has(o.seatId));

  const settled = await Promise.allSettled(
    participants.map(async (own) => {
      const seat = seatsById.get(own.seatId)!;
      const { system, user } = buildDebatePrompt(
        input,
        seat,
        own,
        anonymiseOpinions(opinions, labels, own.seatId),
      );
      const { value, model, latencyMs, calls } = await councilChatJson(
        { seat, system, user, signal },
        DebateResponseSchema,
      );
      const statement: DebateStatement = {
        seatId: seat.id,
        model,
        role: seat.role,
        revisedVerdict: value.revisedVerdict,
        revisedConfidence: value.revisedConfidence,
        revisedProbability: normalizeProbability(
          coerceProbability(value.revisedProbability),
          value.revisedConfidence,
        ),
        critique: value.critique,
        citedRuleRefs: filterValidRuleRefs(value.citedRuleRefs ?? [], input.candidates),
        // Trust the observed change over the model's self-report: a seat that
        // flips its verdict while claiming it did not is still a flip.
        changedMind:
          value.revisedVerdict !== own.verdict || Boolean(value.changedMind),
        latencyMs,
      };
      // `calls` travels with the statement: councilChatJson may have spent a
      // retry, and counting one call per settled seat would under-report the
      // council's real cost against the single-call baseline arm.
      return { statement, calls };
    }),
  );

  const statements: DebateStatement[] = [];
  const failedSeats: string[] = [];
  let totalCalls = 0;

  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      totalCalls += result.value.calls;
      statements.push(result.value.statement);
    } else {
      // A rejection means the seat exhausted councilChatJson; it still cost at
      // least the one request that failed.
      totalCalls += 1;
      const seatId = participants[i].seatId;
      failedSeats.push(seatId);
      console.warn(`[Council] debate seat ${seatId} failed: ${String(result.reason)}`);
    }
  });

  return { statements, failedSeats, totalCalls };
}

/**
 * A seat's current position, whatever round produced it. Structurally a
 * `VerdictSample`, so it feeds `computeAgreement` directly while still carrying
 * the prose needed to assemble the final answer.
 */
export interface SeatPosition extends VerdictSample {
  seatId: string;
  role: CouncilRole;
  confidence: Confidence;
  reasoning: string;
}

export function positionsFromOpinions(opinions: PanelOpinion[]): SeatPosition[] {
  return opinions.map((o) => ({
    seatId: o.seatId,
    role: o.role,
    verdict: o.verdict,
    confidence: o.confidence,
    selfProbability: o.selfProbability,
    citedRuleRefs: o.citedRuleRefs,
    reasoning: o.reasoning,
  }));
}

/**
 * The council's position AFTER debate: each seat's revised statement where it
 * produced one, its round-1 opinion where it did not. This is what stage-2
 * agreement is measured over.
 */
export function positionsAfterDebate(
  opinions: PanelOpinion[],
  statements: DebateStatement[],
): SeatPosition[] {
  const revised = new Map(statements.map((s) => [s.seatId, s]));
  return opinions.map((o) => {
    const r = revised.get(o.seatId);
    if (!r) {
      return {
        seatId: o.seatId,
        role: o.role,
        verdict: o.verdict,
        confidence: o.confidence,
        selfProbability: o.selfProbability,
        citedRuleRefs: o.citedRuleRefs,
        reasoning: o.reasoning,
      };
    }
    return {
      seatId: r.seatId,
      role: r.role,
      verdict: r.revisedVerdict,
      confidence: r.revisedConfidence,
      selfProbability: r.revisedProbability,
      citedRuleRefs: r.citedRuleRefs,
      reasoning: r.critique,
    };
  });
}

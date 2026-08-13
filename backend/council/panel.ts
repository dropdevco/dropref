import { z } from 'zod';
import { normalizeProbability } from './agreement';
import { CouncilCallError, councilChatJson } from './client';
import { buildPanelPrompt, filterValidRuleRefs } from './prompts';
import type { CouncilConfig, CouncilInput, CouncilSeat, PanelOpinion } from './types';

/** Stage 1: every seat forms an opinion alone, in parallel. */

/**
 * `selfProbability` is accepted as a loose number and normalised afterwards —
 * models emit 85 as often as 0.85, and strings as often as numbers. Rejecting
 * those in the schema would burn the seat's one retry on a trivially fixable
 * shape.
 */
export const PanelResponseSchema = z.object({
  verdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  selfProbability: z.union([z.number(), z.string()]).nullish(),
  reasoning: z.string().min(1),
  citedRuleRefs: z.array(z.string()).nullish(),
});

export type PanelResponse = z.infer<typeof PanelResponseSchema>;

/** A percentage (85) and a probability (0.85) are both common; 0..1 wins. */
export function coerceProbability(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n > 1 && n <= 100 ? n / 100 : n;
}

export interface SeatRunResult {
  opinion: PanelOpinion;
  calls: number;
}

async function runSeat(
  seat: CouncilSeat,
  input: CouncilInput,
  signal: AbortSignal,
): Promise<SeatRunResult> {
  const started = Date.now();
  const { system, user } = buildPanelPrompt(input, seat);

  try {
    const { value, model, latencyMs, calls } = await councilChatJson(
      { seat, system, user, signal },
      PanelResponseSchema,
    );
    return {
      calls,
      opinion: {
        seatId: seat.id,
        model,
        role: seat.role,
        verdict: value.verdict,
        confidence: value.confidence,
        selfProbability: normalizeProbability(
          coerceProbability(value.selfProbability),
          value.confidence,
        ),
        reasoning: value.reasoning,
        citedRuleRefs: filterValidRuleRefs(value.citedRuleRefs ?? [], input.candidates),
        latencyMs,
      },
    };
  } catch (err) {
    const message =
      err instanceof CouncilCallError || err instanceof Error
        ? err.message
        : String(err);
    console.warn(`[Council] seat ${seat.id} failed: ${message}`);
    return {
      calls: 1,
      opinion: {
        seatId: seat.id,
        model: seat.model,
        role: seat.role,
        verdict: 'INCONCLUSIVE',
        confidence: 'LOW',
        selfProbability: 0,
        reasoning: '',
        citedRuleRefs: [],
        error: message,
        latencyMs: Date.now() - started,
      },
    };
  }
}

export interface PanelRunResult {
  opinions: PanelOpinion[];
  /** Seats whose opinion is unusable; excluded from every metric. */
  failedSeats: string[];
  totalCalls: number;
}

/**
 * Run every seat in PARALLEL. `allSettled` plus the per-seat catch above means
 * a dead provider costs one seat, never the request: the caller proceeds as
 * long as `quorum` seats returned.
 */
export async function runPanel(
  input: CouncilInput,
  config: CouncilConfig,
  signal: AbortSignal,
): Promise<PanelRunResult> {
  const settled = await Promise.allSettled(
    config.seats.map((seat) => runSeat(seat, input, signal)),
  );

  const opinions: PanelOpinion[] = [];
  const failedSeats: string[] = [];
  let totalCalls = 0;

  settled.forEach((result, i) => {
    const seat = config.seats[i];
    if (result.status === 'fulfilled') {
      totalCalls += result.value.calls;
      opinions.push(result.value.opinion);
      if (result.value.opinion.error) failedSeats.push(seat.id);
      return;
    }
    // runSeat catches its own errors, so this is a defensive path only.
    totalCalls += 1;
    failedSeats.push(seat.id);
    opinions.push({
      seatId: seat.id,
      model: seat.model,
      role: seat.role,
      verdict: 'INCONCLUSIVE',
      confidence: 'LOW',
      selfProbability: 0,
      reasoning: '',
      citedRuleRefs: [],
      error: String(result.reason),
      latencyMs: 0,
    });
  });

  return { opinions, failedSeats, totalCalls };
}

/** Opinions usable for scoring — a failed seat must not dilute the metrics. */
export function validOpinions(opinions: PanelOpinion[]): PanelOpinion[] {
  return opinions.filter((o) => !o.error);
}

import type { Confidence, Verdict } from '../../types/contract';
import {
  accuracyScore,
  clamp01,
  computeAgreement,
  modalVerdict,
  normalizeProbability,
  reliabilityBand,
  REVIEW_SUGGESTED_MIN,
  TRUSTWORTHY_MIN,
} from './agreement';
import { runChair } from './chair';
import {
  positionsAfterDebate,
  positionsFromOpinions,
  runDebate,
  type SeatPosition,
} from './debate';
import { baselineSeat, defaultCouncilConfig } from './models';
import {
  coerceProbability,
  PanelResponseSchema,
  runPanel,
  validOpinions,
} from './panel';
import { buildPanelPrompt, citeRulesByRef, filterValidRuleRefs } from './prompts';
import { councilChatJson } from './client';
import type {
  AgreementMetrics,
  CouncilConfig,
  CouncilInput,
  CouncilResult,
  DebateStatement,
  PanelOpinion,
} from './types';

export { defaultCouncilConfig, defaultSeats, extendedSeats, defaultChair } from './models';
export type { SeatPosition } from './debate';

/** Thrown when too few seats returned for the result to mean anything. */
export class CouncilQuorumError extends Error {
  readonly failedSeats: string[];
  constructor(returned: number, quorum: number, failedSeats: string[]) {
    super(
      `Council quorum not met: ${returned} usable opinion(s), need ${quorum}. Failed seats: ${
        failedSeats.join(', ') || 'none'
      }`,
    );
    this.name = 'CouncilQuorumError';
    this.failedSeats = failedSeats;
  }
}

/**
 * Union of the seats that failed in any round, first-seen order, deduplicated.
 * A seat that dies in the panel AND in the debate is one broken seat, not two.
 */
function mergeFailedSeats(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    for (const id of list) {
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

/** Both escalation gates must pass for the council to stop early. */
function settled(m: AgreementMetrics, config: CouncilConfig): boolean {
  return (
    m.consensusRatio >= config.consensusThreshold &&
    m.meanProbability >= config.minProbability
  );
}

/**
 * A split council must not be allowed to report HIGH just because its loudest
 * seat did. The band derived from `accuracyScore` is the ceiling.
 */
function capConfidence(stated: Confidence, score: number): Confidence {
  const ceiling: Confidence =
    score >= TRUSTWORTHY_MIN ? 'HIGH' : score >= REVIEW_SUGGESTED_MIN ? 'MEDIUM' : 'LOW';
  const order: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
  return order.indexOf(stated) <= order.indexOf(ceiling) ? stated : ceiling;
}

/** Most common stated confidence among the seats holding the winning verdict. */
function modalConfidence(positions: SeatPosition[]): Confidence {
  const tally: Record<Confidence, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const p of positions) tally[p.confidence] += 1;
  const order: Confidence[] = ['LOW', 'MEDIUM', 'HIGH'];
  return order.reduce((best, c) => (tally[c] > tally[best] ? c : best), 'LOW' as Confidence);
}

/** Refs cited by the winning bloc, most-cited first. */
function consensusRefs(holders: SeatPosition[]): string[] {
  const counts = new Map<string, number>();
  for (const h of holders) {
    for (const ref of h.citedRuleRefs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ref]) => ref);
}

function councilNote(
  positions: SeatPosition[],
  winner: Verdict,
  stage: CouncilResult['stage'],
): string {
  const holders = positions.filter((p) => p.verdict === winner);
  const dissent = positions
    .filter((p) => p.verdict !== winner)
    .map((p) => `${p.role} → ${p.verdict}`);
  const round = stage === 'panel' ? 'independent round' : 'after debate';
  return dissent.length === 0
    ? `Council: all ${positions.length} seats agreed (${round}).`
    : `Council: ${holders.length}/${positions.length} seats agreed (${round}); dissent: ${dissent.join(', ')}.`;
}

/**
 * Assemble the answer from the winning bloc. The single highest-probability
 * holder supplies the prose (a synthesised average of several seats' wording
 * reads worse and cites less precisely than one seat's actual argument), and a
 * one-line council note records the spread it came from.
 */
function assemble(
  positions: SeatPosition[],
  input: CouncilInput,
  metrics: AgreementMetrics,
  stage: CouncilResult['stage'],
): {
  verdict: Verdict;
  confidence: Confidence;
  reasoning: string;
  refs: string[];
  score: number;
} {
  const winner = modalVerdict(positions);
  const holders = positions.filter((p) => p.verdict === winner);
  const lead =
    holders.slice().sort((a, b) => b.selfProbability - a.selfProbability)[0] ??
    positions[0];
  const score = accuracyScore(metrics);
  return {
    verdict: winner,
    confidence: capConfidence(modalConfidence(holders), score),
    reasoning: `${lead?.reasoning ?? 'No usable reasoning was returned.'}\n\n${councilNote(
      positions,
      winner,
      stage,
    )}`,
    refs: filterValidRuleRefs(consensusRefs(holders), input.candidates),
    score,
  };
}

/**
 * Run the council with adaptive escalation.
 *
 * 1. All seats in parallel. If they agree confidently, stop — this is the
 *    common path and it costs the same wall-clock as today's single call,
 *    because the seats run concurrently.
 * 2. Otherwise a debate round: every seat sees the others ANONYMISED and may
 *    revise. Still cheap models, still parallel.
 * 3. Only if the council remains split does the expensive chair read the
 *    transcript and rule.
 */
export async function runCouncil(
  input: CouncilInput,
  config: CouncilConfig = defaultCouncilConfig(),
): Promise<CouncilResult> {
  if (!config.enabled) return runSingleModel(input, config);

  const start = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    /* ---- Stage 1: independent panel ---- */
    const panel = await runPanel(input, config, controller.signal);
    const usable = validOpinions(panel.opinions);
    let totalCalls = panel.totalCalls;

    if (usable.length < config.quorum) {
      throw new CouncilQuorumError(usable.length, config.quorum, panel.failedSeats);
    }

    const panelPositions = positionsFromOpinions(usable);
    const panelMetrics = computeAgreement(
      panelPositions,
      undefined,
      config.seats.length,
    );

    if (settled(panelMetrics, config)) {
      return finish({
        input,
        stage: 'panel',
        positions: panelPositions,
        metrics: panelMetrics,
        opinions: panel.opinions,
        debate: [],
        failedSeats: panel.failedSeats,
        totalCalls,
        start,
      });
    }

    /* ---- Stage 2: debate ---- */
    const debate = await runDebate(input, config, usable, controller.signal);
    totalCalls += debate.totalCalls;

    // A seat can survive the panel and die in the debate. `failedSeats` is the
    // observability surface for exactly that, so it carries BOTH rounds'
    // casualties; a seat that failed twice is still one entry.
    const failedSeats = mergeFailedSeats(panel.failedSeats, debate.failedSeats);

    const debatePositions = positionsAfterDebate(usable, debate.statements);
    const debateMetrics = computeAgreement(
      debatePositions,
      undefined,
      config.seats.length,
    );

    if (settled(debateMetrics, config)) {
      return finish({
        input,
        stage: 'debate',
        positions: debatePositions,
        metrics: debateMetrics,
        opinions: panel.opinions,
        debate: debate.statements,
        failedSeats,
        totalCalls,
        start,
      });
    }

    /* ---- Stage 3: chair ---- */
    // The chair runs on its OWN deadline rather than whatever is left of the
    // shared budget. Sharing one clock meant the panel and debate rounds could
    // spend it all and abort the chair on precisely the contested cases the
    // chair exists to settle — and since a dead chair falls back to the
    // post-debate majority at `stage: 'debate'`, that was nearly invisible.
    const chairController = new AbortController();
    const chairBudget = config.chairTimeoutMs ?? config.timeoutMs;
    const chairDeadline = setTimeout(() => chairController.abort(), chairBudget);
    try {
      const ruling = await runChair(
        input,
        config,
        usable,
        debate.statements,
        chairController.signal,
      );
      clearTimeout(chairDeadline);
      totalCalls += ruling.calls;

      // Support for THE ANSWER, not for the modal verdict: the chair may have
      // overruled the panel, and the score has to reflect how alone it is.
      //
      // The chair's OWN vote is deliberately excluded from this tally. It used
      // to be appended, which let the tie-breaker vote in the count that
      // measures how contested its own ruling was: on a 2-1 panel the chair
      // ruling with the minority lifted consensus 1/3 -> 2/4 AND pulled
      // meanProbability up with its own self-report, worth +0.079 — enough to
      // cross the TRUSTWORTHY boundary near the margin. The score asks "how
      // alone is this answer among the seats?", so the chair cannot be one of
      // the seats answering it.
      const chairFocused = computeAgreement(
        debatePositions,
        ruling.verdict,
        config.seats.length,
      );
      const score = accuracyScore(chairFocused);

      return {
        verdict: ruling.verdict,
        confidence: capConfidence(ruling.confidence, score),
        reasoning: `${ruling.reasoning}\n\n${councilNote(
          debatePositions,
          ruling.verdict,
          'debate',
        )} The chair ruled after reviewing the full transcript.`,
        rulesCited: citeRulesByRef(ruling.citedRuleRefs, input.candidates),
        accuracyScore: score,
        reliability: reliabilityBand(score),
        stage: 'chair',
        // Focused on the RETURNED verdict, not the modal one. Shipping
        // `debateMetrics` here let `agreement.distribution` describe a
        // different answer than `verdict` — a UI reading both would state the
        // opposite of the ruling. `agreementFocus` now always equals `verdict`.
        agreement: chairFocused,
        opinions: panel.opinions,
        debate: debate.statements,
        chairRationale: ruling.rationale,
        failedSeats,
        totalCalls,
        processingMs: Date.now() - start,
      };
    } catch (err) {
      // A dead chair is not a dead request: report the post-debate majority and
      // let `reliability` say it is not trustworthy.
      clearTimeout(chairDeadline);
      console.warn(
        `[Council] chair failed, falling back to post-debate majority: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      totalCalls += 1;
      return finish({
        input,
        stage: 'debate',
        positions: debatePositions,
        metrics: debateMetrics,
        opinions: panel.opinions,
        debate: debate.statements,
        failedSeats: mergeFailedSeats(failedSeats, [config.chair.id]),
        totalCalls,
        start,
      });
    }
  } finally {
    clearTimeout(deadline);
  }
}

function finish(args: {
  input: CouncilInput;
  stage: 'panel' | 'debate';
  positions: SeatPosition[];
  metrics: AgreementMetrics;
  opinions: PanelOpinion[];
  debate: DebateStatement[];
  failedSeats: string[];
  totalCalls: number;
  start: number;
}): CouncilResult {
  const a = assemble(args.positions, args.input, args.metrics, args.stage);
  return {
    verdict: a.verdict,
    confidence: a.confidence,
    reasoning: a.reasoning,
    rulesCited: citeRulesByRef(a.refs, args.input.candidates),
    accuracyScore: a.score,
    reliability: reliabilityBand(a.score),
    stage: args.stage,
    agreement: args.metrics,
    opinions: args.opinions,
    debate: args.debate,
    failedSeats: args.failedSeats,
    totalCalls: args.totalCalls,
    processingMs: Date.now() - args.start,
  };
}

/**
 * Baseline arm of the A/B: ONE model, ONE call, same `CouncilResult` shape.
 *
 * `accuracyScore` is the model's own self-probability, NOT the council formula.
 * A lone seat trivially "agrees with itself", so the formula would hand it a
 * floor of 0.70 for no evidence at all and make the two arms incomparable on
 * calibration — the exact thing the harness is measuring.
 */
export async function runSingleModel(
  input: CouncilInput,
  config: CouncilConfig = defaultCouncilConfig(),
): Promise<CouncilResult> {
  const start = Date.now();
  const seat = baselineSeat(config);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const { system, user } = buildPanelPrompt(input, seat);
    const { value, model, latencyMs, calls } = await councilChatJson(
      { seat, system, user, signal: controller.signal },
      PanelResponseSchema,
    );

    const refs = filterValidRuleRefs(value.citedRuleRefs ?? [], input.candidates);
    const opinion: PanelOpinion = {
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
      citedRuleRefs: refs,
      latencyMs,
    };

    const score = clamp01(opinion.selfProbability);
    return {
      verdict: opinion.verdict,
      confidence: opinion.confidence,
      reasoning: opinion.reasoning,
      rulesCited: citeRulesByRef(refs, input.candidates),
      accuracyScore: score,
      reliability: reliabilityBand(score),
      stage: 'panel',
      agreement: computeAgreement([opinion]),
      opinions: [opinion],
      debate: [],
      failedSeats: [],
      totalCalls: calls,
      processingMs: Date.now() - start,
    };
  } finally {
    clearTimeout(deadline);
  }
}

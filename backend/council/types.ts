import type {
  CitedRule,
  Confidence,
  SportId,
  SportRule,
  Verdict,
} from '../../types/contract';

/** One seat on the council: a model plus the lens it argues from. */
export interface CouncilSeat {
  /** Stable id used in logs, metrics and debate transcripts. */
  id: string;
  /** OpenRouter model slug, e.g. 'google/gemini-2.5-flash'. */
  model: string;
  /** The persona/lens this seat reasons from. Diversity here is the point. */
  role: CouncilRole;
  /** Sampling temperature for this seat. */
  temperature: number;
}

/**
 * Distinct reasoning lenses. Running one prompt through N models produces
 * correlated answers; running N *different questions* is what actually
 * surfaces disagreement worth debating.
 */
export type CouncilRole =
  | 'literalist'   // applies rule text strictly, no inference beyond the words
  | 'contextualist'// weighs intent, severity and game context
  | 'skeptic'      // hunts for insufficient evidence; biased toward INCONCLUSIVE
  | 'prosecutor'   // argues the offence DID occur
  | 'defender'     // argues the offence did NOT occur
  | 'chair';       // synthesises; only seat that sees all opinions

/** A single seat's independent opinion, before any debate. */
export interface PanelOpinion {
  seatId: string;
  model: string;
  role: CouncilRole;
  verdict: Verdict;
  confidence: Confidence;
  /** Self-reported probability the verdict is right, 0..1. Used for calibration. */
  selfProbability: number;
  reasoning: string;
  /** Unique refs (see rule-ref.ts), NOT bare codes. */
  citedRuleRefs: string[];
  /** Null when the seat errored; the run continues with a quorum. */
  error?: string;
  latencyMs: number;
}

/** One seat's critique of the panel's spread, in the debate round. */
export interface DebateStatement {
  seatId: string;
  model: string;
  role: CouncilRole;
  /** Did this seat change its mind after seeing the others? */
  revisedVerdict: Verdict;
  revisedConfidence: Confidence;
  revisedProbability: number;
  /** Which opposing argument it found strongest, and why it does/doesn't yield. */
  critique: string;
  citedRuleRefs: string[];
  changedMind: boolean;
  latencyMs: number;
}

/** How much the council agreed — the core accuracy signal. */
export interface AgreementMetrics {
  /**
   * Share of the EXPECTED panel holding `agreementFocus`, 0..1.
   *
   * The denominator is coverage-aware (see `coverageFloor` in agreement.ts): a
   * seat that never answered still counts against the ratio, so a 2-of-3 panel
   * can no longer read as unanimous.
   */
  consensusRatio: number;
  /** Normalised Shannon entropy over the verdict distribution, 0 (unanimous) .. 1 (maximally split). */
  verdictEntropy: number;
  /** Jaccard overlap of cited rule sets across seats, 0..1. */
  citationAgreement: number;
  /** Mean self-reported probability among seats holding `agreementFocus`. */
  meanProbability: number;
  /** Raw verdict tally over the seats that actually answered. */
  distribution: Record<Verdict, number>;
  /**
   * The verdict `consensusRatio` and `meanProbability` are measured AGAINST.
   * Always the verdict the council returned, so a consumer reading `agreement`
   * next to `verdict` cannot be told about a different answer than the one it
   * is showing.
   *
   * Optional only so that pre-existing hand-built literals still typecheck;
   * every value produced by `computeAgreement` sets it.
   */
  agreementFocus?: Verdict;
  /**
   * The denominator `consensusRatio` was divided by. Equals the number of
   * usable opinions on a full panel and the expected panel size on a degraded
   * one, so `distribution` summing below it IS the coverage shortfall.
   */
  consensusDenominator?: number;
}

/** Why the council stopped where it did. */
export type EscalationStage = 'panel' | 'debate' | 'chair';

export interface CouncilResult {
  verdict: Verdict;
  confidence: Confidence;
  reasoning: string;
  rulesCited: CitedRule[];
  /** 0..1 calibrated estimate that `verdict` is correct. THE accuracy number. */
  accuracyScore: number;
  /** Actionable band derived from accuracyScore + agreement. */
  reliability: 'TRUSTWORTHY' | 'REVIEW_SUGGESTED' | 'UNRELIABLE';
  /** How far escalation went before settling. */
  stage: EscalationStage;
  agreement: AgreementMetrics;
  opinions: PanelOpinion[];
  debate: DebateStatement[];
  /** Present only when the chair was invoked. */
  chairRationale?: string;
  /** Seats that failed, for observability. */
  failedSeats: string[];
  totalCalls: number;
  processingMs: number;
}

export interface CouncilConfig {
  seats: CouncilSeat[];
  chair: CouncilSeat;
  /** Skip debate when consensusRatio >= this AND meanProbability >= minProbability. */
  consensusThreshold: number;
  minProbability: number;
  /** Minimum seats that must return before a result is usable. */
  quorum: number;
  /** Hard ceiling on wall-clock for the whole council. */
  timeoutMs: number;
  /**
   * Dedicated budget for the chair, on its own deadline. Optional so existing
   * hand-built configs keep working; falls back to the remaining total.
   */
  chairTimeoutMs?: number;
  /** When false, runs a single seat — the baseline arm of the A/B. */
  enabled: boolean;
}

export interface CouncilInput {
  sport: SportId;
  displayName: string;
  /** The stage-1 observation text. */
  observation: string;
  originalCall: string | null;
  candidates: SportRule[];
  /**
   * Facts the observation stage could NOT settle, one line each.
   *
   * Optional, and absent means "nothing was contested OR nobody checked" —
   * every pre-graph caller (including the eval harness, whose golden cases
   * carry a single hand-written observation) keeps working unchanged.
   *
   * When present these are shown to every seat, to the debate round and to the
   * chair. A verdict resting on a fact listed here is resting on something the
   * observers disagreed about, and the seats are told to treat it that way.
   */
  contested?: string[];
}

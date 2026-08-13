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
  /** Share of seats holding the modal verdict, 0..1. */
  consensusRatio: number;
  /** Normalised Shannon entropy over the verdict distribution, 0 (unanimous) .. 1 (maximally split). */
  verdictEntropy: number;
  /** Jaccard overlap of cited rule sets across seats, 0..1. */
  citationAgreement: number;
  /** Mean self-reported probability among seats holding the modal verdict. */
  meanProbability: number;
  /** Raw verdict tally. */
  distribution: Record<Verdict, number>;
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
}

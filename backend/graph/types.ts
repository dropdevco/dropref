import type {
  CitedRule,
  Confidence,
  SportId,
  Verdict,
} from '../../types/contract';
import type { AgreementMetrics, CouncilResult } from '../council/types';

/**
 * The state contract for the analysis graph.
 *
 * Every node reads a declared slice of this and writes a declared slice back.
 * The shapes here ARE the artifact formats written under `backend/runs/<runId>/`
 * — one file per node — so a wrong verdict can be traced to the node that
 * introduced it rather than reconstructed from a log line.
 */

/* ------------------------------------------------------------------ */
/* Observation stage                                                   */
/* ------------------------------------------------------------------ */

/** Which evidence an observer was shown. The diversity that matters. */
export type ObserverLens = 'raw' | 'annotated';

export interface ObserverReport {
  observerId: string;
  model: string;
  lens: ObserverLens;
  /** This observer's account of the play. Empty when it errored. */
  description: string;
  error?: string;
  latencyMs: number;
}

/**
 * The reconciled account handed to the council, plus what the observers could
 * not agree on.
 *
 * `contested` is the payload that makes the fan-out worth paying for: a fact
 * only one observer saw is exactly the fact a confident verdict should not be
 * built on, and the seats are told so explicitly.
 */
export interface ObservationBundle {
  /** The description every downstream node reads. */
  observation: string;
  /** Facts the observers disagreed about, or that only one of them asserted. */
  contested: string[];
  /**
   * 0..1 agreement between the observers, or `null` when only one ran.
   *
   * `null` is NOT zero. A single-observer run has no evidence of disagreement
   * and must not be penalised as though it had — see `observationFactor`.
   */
  observationAgreement: number | null;
  observers: ObserverReport[];
  /** False when the reconciler was skipped (one observer) or died. */
  reconciled: boolean;
  /** Observer ids that produced nothing usable, plus 'reconciler' if it died. */
  failedNodes: string[];
  totalCalls: number;
  processingMs: number;
}

/* ------------------------------------------------------------------ */
/* Audit stage                                                         */
/* ------------------------------------------------------------------ */

/**
 * The independent checker's findings on the answer the council produced.
 *
 * Note what is NOT here: a score. The auditor reports FINDINGS and the penalty
 * is computed from them in `score.ts`. A model asked directly for its own
 * penalty multiplier returns a vibe, and it would also be the third place in
 * this system where a model grades on a scale it invented.
 */
export interface AuditFindings {
  /** Claims in the verdict's reasoning that the observation actually supports. */
  supportedClaims: string[];
  /** Claims the observation does not establish. */
  unsupportedClaims: string[];
  /** Cited refs the auditor says do not govern this play. */
  ruleMisuse: string[];
  /** True when the verdict is more certain than the evidence permits. */
  overreach: boolean;
  notes: string;
}

export interface AuditResult extends AuditFindings {
  model: string;
  /** True when the auditor produced nothing usable. See `AUDIT_FAILED_*`. */
  failed: boolean;
  error?: string;
  latencyMs: number;
  calls: number;
}

/* ------------------------------------------------------------------ */
/* Scoring + gate                                                      */
/* ------------------------------------------------------------------ */

export interface ReliabilityBreakdown {
  /** The council's own agreement composite. Unchanged from agreement.ts. */
  accuracyScore: number;
  /** Penalty for observers disagreeing. 1.0 when there is nothing to penalise. */
  observationFactor: number;
  /** Penalty for unsupported claims / misused rules / overreach. */
  auditFactor: number;
  /** accuracyScore x observationFactor x auditFactor. */
  reliabilityScore: number;
  reliability: CouncilResult['reliability'];
  /** Why the human gate fired, empty when it did not. */
  gateReasons: string[];
  needsHumanReview: boolean;
}

/* ------------------------------------------------------------------ */
/* Whole-run state                                                     */
/* ------------------------------------------------------------------ */

export interface GraphInput {
  sport: SportId;
  /**
   * The ORIGINAL clip, never the CV-annotated one. Observer A reads this and
   * nothing else; handing it the annotated video would give both observers the
   * same evidence and collapse the fan-out into two samples of one opinion.
   */
  videoBase64: string;
  videoMimeType: string;
  /** CV-annotated render, when the CV service produced one. Observer B only. */
  annotatedVideoBase64: string | null;
  skeletonBase64: string | null;
  originalCall: string | null;
  cvMetadata: unknown;
  keyFramesBase64: string[] | null;
}

export interface GraphResult {
  runId: string;
  sport: SportId;
  verdict: Verdict;
  confidence: Confidence;
  observation: ObservationBundle;
  council: CouncilResult;
  audit: AuditResult;
  score: ReliabilityBreakdown;
  reasoning: string;
  rulesCited: CitedRule[];
  agreement: AgreementMetrics;
  originalCall: string | null;
  totalCalls: number;
  processingMs: number;
}

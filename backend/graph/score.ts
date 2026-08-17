import { clamp01, reliabilityBand } from '../council/agreement';
import type { AuditResult, ObservationBundle, ReliabilityBreakdown } from './types';

/**
 * Reliability composition and the human gate.
 *
 * DESIGN CONSTRAINT: `accuracyScore` in backend/council/agreement.ts is NOT
 * touched. Its weights are calibrated against documented emitted values, its
 * cut-points (0.75 / 0.50) were chosen against those values, and both are
 * pinned by agreement.test.ts. Folding two more terms into that weighted sum
 * would have silently moved every band boundary in the product.
 *
 * So the new evidence composes multiplicatively instead:
 *
 *     reliabilityScore = accuracyScore x observationFactor x auditFactor
 *
 * Both factors live in [MIN_FACTOR, 1] and equal exactly 1 when there is
 * nothing to penalise, so a run with no observer fan-out and a clean audit
 * scores precisely what the council alone would have scored. That property is
 * what makes the eval harness able to report both numbers side by side and
 * attribute any difference to the new nodes.
 */

/**
 * Floor on each factor.
 *
 * The bound is the point. One checker, however damning, should not be able to
 * zero out three independently-lensed seats agreeing — that would just move the
 * single point of failure from the panel to the auditor. Each factor can cost
 * at most 40% of the score; together at most 64%, which is enough to drag any
 * verdict out of TRUSTWORTHY and most of the way out of REVIEW_SUGGESTED.
 */
export const MIN_FACTOR = 0.6;

/** Multiplied in when the auditor says a cited rule does not govern the play. */
export const RULE_MISUSE_PENALTY = 0.9;

/** Multiplied in when the auditor says the verdict outruns its evidence. */
export const OVERREACH_PENALTY = 0.85;

function clampFactor(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(1, Math.max(MIN_FACTOR, n));
}

/**
 * Penalty for the observers disagreeing about what happened.
 *
 * `null` means the disagreement was never MEASURED — a single-observer run,
 * or a reconciler that died — and returns 1. Penalising there would punish a
 * run for evidence it was never given and would make a degraded run look worse
 * than a genuinely contested one, which reads the signal backwards. The human
 * gate handles the unmeasured case instead, on its own reason string.
 */
export function observationFactor(agreement: number | null): number {
  if (agreement === null) return 1;
  return clampFactor(MIN_FACTOR + (1 - MIN_FACTOR) * clamp01(agreement));
}

/**
 * Penalty derived from the auditor's findings.
 *
 * A failed auditor yields 1: it produced no findings, and inventing a penalty
 * out of its absence would be as dishonest as inventing a clean bill of health.
 * The gate fires on `failed` instead, so an unchecked answer can never be shown
 * as TRUSTWORTHY.
 */
export function auditFactor(audit: AuditResult): number {
  if (audit.failed) return 1;

  const supported = audit.supportedClaims.length;
  const unsupported = audit.unsupportedClaims.length;
  const total = supported + unsupported;

  // No claims enumerated at all: nothing was checked, so nothing is penalised.
  const supportRatio = total === 0 ? 1 : supported / total;

  let factor = MIN_FACTOR + (1 - MIN_FACTOR) * supportRatio;
  if (audit.ruleMisuse.length > 0) factor *= RULE_MISUSE_PENALTY;
  if (audit.overreach) factor *= OVERREACH_PENALTY;
  return clampFactor(factor);
}

/**
 * Compose the final score and decide whether a human must see it first.
 *
 * The gate holds on any of:
 *  - the band is not TRUSTWORTHY — the ordinary case
 *  - the auditor did not run — the answer is unchecked, whatever it scored
 *  - two observers ran but were never reconciled — the premise is unchecked
 *  - the auditor found overreach — a direct finding that the verdict claims
 *    more than the evidence supports, which must hold even when the arithmetic
 *    still lands above the line
 *
 * A degraded council (`failedSeats`) is deliberately NOT its own reason:
 * `coverageFloor` in agreement.ts already counts a missing seat against
 * consensus, so gating on it too would penalise the same event twice.
 */
export function composeReliability(
  accuracyScore: number,
  observation: ObservationBundle,
  audit: AuditResult,
): ReliabilityBreakdown {
  const obsFactor = observationFactor(observation.observationAgreement);
  const audFactor = auditFactor(audit);
  const reliabilityScore = clamp01(clamp01(accuracyScore) * obsFactor * audFactor);
  const reliability = reliabilityBand(reliabilityScore);

  const gateReasons: string[] = [];
  if (reliability !== 'TRUSTWORTHY') {
    gateReasons.push(`reliability is ${reliability} (score ${reliabilityScore.toFixed(2)})`);
  }
  if (audit.failed) {
    gateReasons.push('the evidence auditor did not run, so this answer is unchecked');
  }
  if (observation.failedNodes.includes('reconciler')) {
    gateReasons.push('two observers ran but could not be reconciled, so the premise is unchecked');
  }
  if (audit.overreach) {
    gateReasons.push('the auditor found the verdict states more than the evidence supports');
  }

  return {
    accuracyScore: clamp01(accuracyScore),
    observationFactor: obsFactor,
    auditFactor: audFactor,
    reliabilityScore,
    reliability,
    gateReasons,
    needsHumanReview: gateReasons.length > 0,
  };
}

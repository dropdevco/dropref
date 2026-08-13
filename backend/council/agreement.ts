import type { Confidence, Verdict } from '../../types/contract';
import type { AgreementMetrics, CouncilResult } from './types';

/**
 * Pure agreement mathematics for the council. NO network, NO env, NO imports
 * beyond types — everything here is deterministic and unit-testable offline
 * (see `__tests__/agreement.test.ts`).
 */

/** Fixed iteration order so distributions and tie-breaks are deterministic. */
export const VERDICTS: readonly Verdict[] = [
  'FAIR_CALL',
  'BAD_CALL',
  'INCONCLUSIVE',
] as const;

/** Maximum Shannon entropy for a 3-outcome distribution; the entropy normaliser. */
const LOG2_VERDICTS = Math.log2(VERDICTS.length);

/**
 * Midpoint of each `Confidence` band, used when a model omits or mangles its
 * `selfProbability`. Bands: LOW 0.0–0.5, MEDIUM 0.5–0.8, HIGH 0.8–1.0.
 */
export const CONFIDENCE_MIDPOINT: Record<Confidence, number> = {
  LOW: 0.25,
  MEDIUM: 0.65,
  HIGH: 0.9,
};

/** The minimal shape the metrics need. `PanelOpinion` satisfies it structurally. */
export interface VerdictSample {
  verdict: Verdict;
  selfProbability: number;
  citedRuleRefs: string[];
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Float noise makes `entropy === 1` an unreliable assertion for callers and
 * makes logged metrics look ragged. Snap only values already within 1e-12 of a
 * boundary; everything else keeps full precision.
 */
function snap01(n: number): number {
  const c = clamp01(n);
  if (Math.abs(c) < 1e-12) return 0;
  if (Math.abs(c - 1) < 1e-12) return 1;
  return c;
}

/**
 * Coerce a model-supplied probability into [0,1]. A missing/NaN/out-of-range
 * value falls back to the midpoint of the band the model *did* state, rather
 * than crashing or silently scoring the seat at 0.
 */
export function normalizeProbability(
  raw: number | null | undefined,
  confidence: Confidence,
): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return CONFIDENCE_MIDPOINT[confidence];
  }
  return clamp01(raw);
}

/**
 * Jaccard similarity of two ref sets.
 *
 * Two empty sets score 1.0. That is a deliberate choice: "cite nothing" is the
 * correct answer for a genuinely INCONCLUSIVE play (the golden set carries
 * empty `expectedRuleRefs` for exactly those cases), so two seats that both
 * declined to cite ARE in perfect agreement. Scoring 0/0 as 0 would penalise
 * the council precisely when it behaves correctly.
 */
export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 1 : inter / union;
}

/**
 * Mean pairwise Jaccard across every seat's cited-ref set.
 *
 * Fewer than two sets means there are no pairs to compare, so the value is
 * vacuously 1.0 — notably true for the single-model baseline arm, where it
 * carries no evidence and must not be read as one.
 */
export function citationAgreement(refSets: string[][]): number {
  if (refSets.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < refSets.length; i += 1) {
    for (let j = i + 1; j < refSets.length; j += 1) {
      total += jaccard(refSets[i], refSets[j]);
      pairs += 1;
    }
  }
  return pairs === 0 ? 1 : snap01(total / pairs);
}

/** Shannon entropy over the verdict tally, normalised by log2(3) into [0,1]. */
export function verdictEntropy(distribution: Record<Verdict, number>): number {
  const n = VERDICTS.reduce((sum, v) => sum + distribution[v], 0);
  if (n <= 0) return 1; // no evidence at all is maximal uncertainty
  let h = 0;
  for (const v of VERDICTS) {
    const p = distribution[v] / n;
    if (p > 0) h -= p * Math.log2(p);
  }
  return snap01(h / LOG2_VERDICTS);
}

/**
 * Modal verdict. Ties break on summed self-probability, then on the fixed
 * `VERDICTS` order, so the same inputs always yield the same winner.
 */
export function modalVerdict(samples: VerdictSample[]): Verdict {
  const counts = emptyDistribution();
  const mass: Record<Verdict, number> = { FAIR_CALL: 0, BAD_CALL: 0, INCONCLUSIVE: 0 };
  for (const s of samples) {
    counts[s.verdict] += 1;
    mass[s.verdict] += clamp01(s.selfProbability);
  }
  let best: Verdict = 'INCONCLUSIVE';
  let bestCount = -1;
  let bestMass = -1;
  for (const v of VERDICTS) {
    if (counts[v] > bestCount || (counts[v] === bestCount && mass[v] > bestMass)) {
      best = v;
      bestCount = counts[v];
      bestMass = mass[v];
    }
  }
  return best;
}

export function emptyDistribution(): Record<Verdict, number> {
  return { FAIR_CALL: 0, BAD_CALL: 0, INCONCLUSIVE: 0 };
}

/**
 * Full metric bundle over the seats that actually returned a usable opinion.
 *
 * `focusVerdict` re-centres `consensusRatio` and `meanProbability` on a given
 * verdict instead of the modal one. The chair stage needs this: once the chair
 * has overruled the panel, "how much support does THE ANSWER have" is the
 * question, and that is not always the modal verdict.
 */
/**
 * Coverage-aware denominator for `consensusRatio`.
 *
 * Dividing by `samples.length` alone means a panel that lost a seat to a
 * provider error reads as MORE unanimous, not less: two survivors agreeing
 * scored 1.0 — identical to three seats agreeing — so a degraded council
 * skipped the debate round and reported TRUSTWORTHY on two thirds of the
 * evidence. Agreement among the seats that happened to answer is not the same
 * quantity as agreement among the seats we asked.
 *
 * We divide by the panel we EXPECTED whenever that is larger. A missing seat
 * therefore counts against consensus exactly as a dissenting one would, which
 * is the conservative reading: we do not know how it would have voted.
 *
 * `quorum + 1` is the floor when the expected size is unknown, so a 2-seat
 * result can never reach 1.0 by default.
 */
export function coverageFloor(
  usable: number,
  expectedPanelSize?: number,
): number {
  return Math.max(usable, expectedPanelSize ?? 0);
}

export function computeAgreement(
  samples: VerdictSample[],
  focusVerdict?: Verdict,
  expectedPanelSize?: number,
): AgreementMetrics {
  const distribution = emptyDistribution();
  for (const s of samples) distribution[s.verdict] += 1;

  const n = samples.length;
  if (n === 0) {
    // Guarded by quorum upstream; defined here so the type is always inhabited.
    return {
      consensusRatio: 0,
      verdictEntropy: 1,
      citationAgreement: 1,
      meanProbability: 0,
      distribution,
      agreementFocus: focusVerdict ?? 'INCONCLUSIVE',
      consensusDenominator: coverageFloor(0, expectedPanelSize),
    };
  }

  const focus = focusVerdict ?? modalVerdict(samples);
  const holders = samples.filter((s) => s.verdict === focus);
  const meanProbability =
    holders.length === 0
      ? 0
      : clamp01(
          holders.reduce((sum, s) => sum + clamp01(s.selfProbability), 0) /
            holders.length,
        );

  const denominator = coverageFloor(n, expectedPanelSize);

  return {
    consensusRatio: snap01(distribution[focus] / denominator),
    verdictEntropy: verdictEntropy(distribution),
    citationAgreement: citationAgreement(samples.map((s) => s.citedRuleRefs)),
    meanProbability,
    distribution,
    agreementFocus: focus,
    consensusDenominator: denominator,
  };
}

/**
 * Weights for `accuracyScore`. They sum to 1.0 and every term is oriented so
 * that "more agreement / more confidence" moves it UP — which is what makes the
 * combined score monotonic.
 *
 *  - consensus 0.40 — the strongest signal the council buys us over a single
 *    model. Independently prompted, differently-lensed models landing on the
 *    same verdict is evidence no amount of self-reported confidence replaces.
 *  - meanProbability 0.30 — informative, but LLMs are systematically
 *    overconfident, so a seat's own claim is worth less than observed
 *    cross-seat behaviour. It gets the second weight, not the first.
 *  - inverse entropy 0.20 — `consensusRatio` only tracks the modal share and
 *    cannot tell 4-1 (one dissenter) from 3-1-1 (the rest scattered). Entropy
 *    catches the shape of the disagreement. Partially redundant with consensus,
 *    hence the smaller weight.
 *  - citationAgreement 0.10 — seats reaching the same verdict via DIFFERENT
 *    rules is a weaker result than reaching it via the same rule. Only a nudge,
 *    because citation sets are noisy (multi-rule plays, shortlist ordering).
 *
 * Deliberately NOT included: how many seats failed. Quorum shortfall is
 * reported through `failedSeats`, not folded in here — mixing coverage into the
 * score would break both purity and monotonicity.
 */
export const ACCURACY_WEIGHTS = {
  consensus: 0.4,
  probability: 0.3,
  entropy: 0.2,
  citation: 0.1,
} as const;

/**
 * One calibrated 0..1 estimate that the council's verdict is correct.
 * Monotonic non-decreasing in consensusRatio, meanProbability and
 * citationAgreement, and non-increasing in verdictEntropy.
 */
export function accuracyScore(m: AgreementMetrics): number {
  const score =
    ACCURACY_WEIGHTS.consensus * clamp01(m.consensusRatio) +
    ACCURACY_WEIGHTS.probability * clamp01(m.meanProbability) +
    ACCURACY_WEIGHTS.entropy * (1 - clamp01(m.verdictEntropy)) +
    ACCURACY_WEIGHTS.citation * clamp01(m.citationAgreement);
  return snap01(score);
}

/**
 * Cut-points, chosen against what the formula actually emits for a 3-seat panel:
 *
 *  - unanimous, mean p 0.80, identical citations → 0.94
 *  - unanimous, mean p 0.55, half-overlapping citations → 0.82
 *  - 2-1 split,  mean p 0.70, half-overlapping citations → 0.61
 *  - 3-way split, mean p 0.50, disjoint citations       → 0.28
 *
 * 0.75 therefore separates "unanimous and reasonably confident" from anything
 * carrying a live dissent; 0.50 separates a bare majority from a genuine split.
 */
export const TRUSTWORTHY_MIN = 0.75;
export const REVIEW_SUGGESTED_MIN = 0.5;

export function reliabilityBand(score: number): CouncilResult['reliability'] {
  if (score >= TRUSTWORTHY_MIN) return 'TRUSTWORTHY';
  if (score >= REVIEW_SUGGESTED_MIN) return 'REVIEW_SUGGESTED';
  return 'UNRELIABLE';
}

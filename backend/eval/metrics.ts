/**
 * Pure scoring maths for the RefCheck AI accuracy harness.
 *
 * HARD CONSTRAINT: this module performs no I/O — no network, no fs, no env.
 * Every function here is deterministic given its arguments, which is what makes
 * the harness testable offline (see __tests__/metrics.test.ts) and what makes
 * its claims auditable: if the numbers are wrong, they are wrong in a way you
 * can reproduce on a hand-written fixture.
 *
 * ---------------------------------------------------------------------------
 * THE PAIRING RULE (defect B2)
 * ---------------------------------------------------------------------------
 * Every cross-arm number in this file is computed over the PAIRED
 * INTERSECTION: the cases that BOTH arms scored. Per-arm denominators are a
 * fabrication engine — if the council errors on 15 cases the baseline scored
 * and got wrong, the council's denominator shrinks by 15 hard cases and its
 * accuracy is flattered for free. On a real 125-case run that inflated the
 * headline delta from +7.3pp to +15.0pp and turned it into a COUNCIL_BETTER
 * banner.
 *
 * `aggregate()` therefore returns a block stamped `basis: 'unpaired'`, and
 * `compare()` REFUSES it. The only way to get a comparison is `compare()`,
 * which takes raw outcomes and does the pairing itself. There is no argument
 * you can pass that makes it compare per-arm denominators.
 */

import type { SportId, Verdict } from '../../types/contract';
import type { CouncilResult } from '../council/types';
import { ruleRef } from '../council/rule-ref';
import type {
  ArmMetrics,
  CaseOutcome,
  ComparisonReport,
  GoldenCase,
  PairingSummary,
  RunMetadata,
  ScoreKind,
  UnpairedArmFigures,
} from './types';

/** The three verdict classes, in a fixed order so reports are stable. */
export const VERDICT_CLASSES: Verdict[] = ['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE'];

/** The three difficulty bands, in a fixed order. */
export const DIFFICULTIES: GoldenCase['difficulty'][] = ['easy', 'medium', 'hard'];

export type ArmName = 'baseline' | 'council';

/**
 * Printed with every report, and returned from `calibrationCaveats()`.
 *
 * SHOULD-FIX 6: ECE and Brier are proper scoring rules for CONFIDENCE, not for
 * correctness, and both are trivially gamed by a constant predictor. An arm
 * that always answers INCONCLUSIVE and always claims 0.20 scores ECE 0.000 —
 * a perfect score — and Brier 0.160 on the real 125-case set, beating a
 * genuinely 75%-accurate arm's Brier of 0.188. It is useless and it wins.
 * Neither number may ever be read without accuracy sitting next to it.
 */
export const CALIBRATION_FOOTNOTE =
  'ECE and Brier must NEVER be read without verdict accuracy beside them. ' +
  'Both are minimised by a CONSTANT predictor: an arm that always answers ' +
  'INCONCLUSIVE and always claims 0.20 scores a perfect ECE of 0.000 and a ' +
  'Brier of 0.160, beating a genuinely 75%-accurate arm (Brier 0.188). A good ' +
  'calibration number on its own is evidence of nothing.';

/** Why ECE deltas between these two arms are not attributable to the council. */
export const SCORE_KIND_FOOTNOTE =
  'The two arms emit DIFFERENT KINDS of claimed probability (see CaseOutcome.scoreKind): ' +
  'the baseline reports a raw self-probability on [0,1], the council reports the ' +
  'accuracyScore composite, which on the settled unanimous path degenerates to ' +
  '0.7 + 0.3*p_self and lives on [0.70,1.00]. A raw ECE delta between them measures ' +
  'that offset interacting with the base rate, not the council. AUROC is the ' +
  'discrimination headline because it is invariant under any monotone rescale.';

/**
 * Why `eceRecalibrated` may not be compared to `eceRaw` as if they were the
 * same kind of measurement. See calibrationBlock() for the derivation.
 */
export const RECALIBRATION_FOOTNOTE =
  'eceRaw is in-sample (the arm supplies the confidence; only the bin accuracy is ' +
  'estimated). eceRecalibrated is out-of-fold and estimates BOTH the monotone map and ' +
  'the accuracy, so it carries an estimation floor of roughly 1/sqrt(n) — about 0.06 on ' +
  'a 125-case set even for an arm that is already perfectly calibrated. Compare the two ' +
  'ARMS on eceRecalibrated, where both pay the same penalty and an arbitrary rescale ' +
  'cancels; never compare an arm to its own eceRaw.';

export interface McNemarResult {
  /** Cases the baseline got right and the council got wrong. */
  b: number;
  /** Cases the council got right and the baseline got wrong. */
  c: number;
  /** EXACT two-sided binomial p-value. */
  pValue: number;
  significant: boolean;
}

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

/** Division that yields 0 rather than NaN/Infinity when the denominator is 0. */
function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/** Harmonic mean of precision and recall; 0 when both are 0 (never NaN). */
export function f1From(precision: number, recall: number): number {
  const denom = precision + recall;
  return denom === 0 ? 0 : (2 * precision * recall) / denom;
}

/**
 * Outcomes that actually produced a verdict. Errored cases are excluded from
 * accuracy-style metrics so a flaky API cannot be mistaken for a wrong answer;
 * they are surfaced separately as `errorRate`.
 *
 * NOTE: excluding errors is correct WITHIN an arm and catastrophic ACROSS arms
 * unless the intersection is taken first. See pairOutcomes().
 */
function scored(outcomes: CaseOutcome[]): CaseOutcome[] {
  return outcomes.filter((o) => !o.error);
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Per-case scoring
// ---------------------------------------------------------------------------

/**
 * Rule-set precision/recall for one case, compared on ruleRef() strings.
 *
 * NEVER compare bare `SportRule.code`: soccer reuses "Law 12.1" across five
 * distinct rules, so code-level comparison would score a citation of
 * "handball" as a correct match for "reckless challenge".
 *
 * EMPTY-SET CONVENTION (expected === []), which is valid and meaningful for
 * INCONCLUSIVE cases:
 *   - recall    = 1 always. Nothing was required, so nothing can have been
 *                 missed. Any other choice would punish a correct "cite
 *                 nothing" answer on a case whose ground truth is "no rule
 *                 applies".
 *   - precision = 1 when the arm also cited nothing, 0 otherwise. When the
 *                 golden answer is "no rule applies", every citation the arm
 *                 produces is junk, so precision collapses to 0 rather than
 *                 being undefined. This is deliberately harsh: fabricated
 *                 citations on an INCONCLUSIVE case are exactly the failure
 *                 mode this harness exists to catch.
 *   - f1        = harmonic mean of the above: 1 when both empty, 0 otherwise.
 *
 * NON-EMPTY expected with an EMPTY actual set: precision = 0 (the denominator
 * is 0, and citing nothing found nothing correct), recall = 0, f1 = 0.
 */
export function ruleSetScores(
  expectedRefs: string[],
  actualRefs: string[],
): { precision: number; recall: number; f1: number } {
  const expected = new Set(expectedRefs);
  const actual = new Set(actualRefs);

  if (expected.size === 0) {
    const precision = actual.size === 0 ? 1 : 0;
    const recall = 1;
    return { precision, recall, f1: f1From(precision, recall) };
  }

  let intersection = 0;
  for (const ref of actual) if (expected.has(ref)) intersection += 1;

  const precision = safeDiv(intersection, actual.size);
  const recall = safeDiv(intersection, expected.size);
  return { precision, recall, f1: f1From(precision, recall) };
}

/** Unique ruleRef() strings for whatever the arm cited. */
export function refsFromResult(result: Pick<CouncilResult, 'rulesCited'>): string[] {
  const seen = new Set<string>();
  for (const cited of result.rulesCited ?? []) {
    seen.add(ruleRef({ code: cited.code, title: cited.title }));
  }
  return [...seen];
}

/**
 * Which KIND of claimed probability an arm emits, by default.
 *
 * The baseline path (backend/council/index.ts runSingleModel) sets
 * `accuracyScore` to the seat's raw selfProbability; the council path sets it
 * to the accuracyScore composite. Callers running a non-standard arm should
 * pass the kind explicitly rather than relying on this mapping.
 */
export function defaultScoreKind(arm: ArmName): ScoreKind {
  return arm === 'baseline' ? 'self_probability' : 'council_formula';
}

/**
 * Score one arm's answer to one golden case.
 *
 * `retrievedRefs` is the candidate shortlist retrieval handed the arm. It is
 * scored separately from the citation because a miss there and a miss in
 * adjudication are different bugs: if the right rule was never in the
 * shortlist, no amount of council debate can recover it, and the fix belongs
 * in backend/rules/retrieve.ts, not in the prompt.
 */
export function scoreCase(
  golden: GoldenCase,
  result: CouncilResult,
  retrievedRefs: string[],
  arm: ArmName = 'council',
  scoreKind: ScoreKind = defaultScoreKind(arm),
): CaseOutcome {
  const expectedRuleRefs = [...new Set(golden.expectedRuleRefs)];
  const actualRuleRefs = refsFromResult(result);
  const { precision, recall, f1 } = ruleSetScores(expectedRuleRefs, actualRuleRefs);

  const retrievedSet = new Set(retrievedRefs);
  // With no expected refs, retrieval cannot have failed — there was nothing to
  // find. Same convention as recall above.
  const retrievalHit =
    expectedRuleRefs.length === 0
      ? true
      : expectedRuleRefs.some((ref) => retrievedSet.has(ref));

  return {
    caseId: golden.id,
    arm,
    expectedVerdict: golden.expectedVerdict,
    actualVerdict: result.verdict,
    verdictCorrect: result.verdict === golden.expectedVerdict,
    expectedRuleRefs,
    actualRuleRefs,
    rulePrecision: precision,
    ruleRecall: recall,
    ruleF1: f1,
    retrievalHit,
    claimedProbability: clamp01(result.accuracyScore),
    scoreKind,
    difficulty: golden.difficulty,
    tag: golden.tag,
    latencyMs: result.processingMs,
    modelCalls: result.totalCalls,
  };
}

// ---------------------------------------------------------------------------
// Discrimination — AUROC (defect B1a)
// ---------------------------------------------------------------------------

/**
 * Area under the ROC curve of `claimedProbability` against the correctness
 * indicator, computed as the Mann-Whitney U statistic with proper mid-rank
 * handling of ties.
 *
 *   AUROC = (sum of ranks of the correct cases - nPos*(nPos+1)/2) / (nPos*nNeg)
 *
 * Read it as: given one case the arm got right and one it got wrong, the
 * probability it assigned the right one a higher score. 0.5 is chance; ties
 * contribute exactly 0.5 each, which is why mid-ranks matter — an arm whose
 * score is CONSTANT scores exactly 0.5, not 1.0.
 *
 * WHY THIS IS THE DISCRIMINATION HEADLINE (defect B1): AUROC depends only on
 * the ORDER of the scores, so it is invariant under any strictly monotone
 * rescale — including the council's degenerate `p -> 0.7 + 0.3p`. On the null
 * experiment where the council answers identically to the baseline and only
 * the scale differs, AUROC returns a delta of exactly 0, while ECE moves by
 * up to 0.086 and flips sign around 90% base accuracy. ECE was measuring the
 * rescale; AUROC cannot.
 *
 * Degenerate cases return 0.5 (chance), never NaN: if every case is correct or
 * every case is wrong there are no pairs to rank and discrimination is simply
 * not measurable on this sample.
 */
export function auroc(outcomes: CaseOutcome[]): number {
  const usable = scored(outcomes);
  const points = usable.map((o) => ({
    p: clamp01(o.claimedProbability),
    y: o.verdictCorrect ? 1 : 0,
  }));
  const nPos = points.filter((pt) => pt.y === 1).length;
  const nNeg = points.length - nPos;
  if (nPos === 0 || nNeg === 0) return 0.5;

  const sorted = [...points].sort((a, b) => a.p - b.p);

  // Mid-ranks: every member of a tied run gets the average of the ranks that
  // run occupies. Without this a constant-score arm would score 1.0 or 0.0
  // depending on sort stability.
  const ranks: number[] = new Array(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].p === sorted[i].p) j += 1;
    // Ranks are 1-based; the run spans ranks i+1 .. j+1.
    const midRank = (i + 1 + (j + 1)) / 2;
    for (let t = i; t <= j; t += 1) ranks[t] = midRank;
    i = j + 1;
  }

  let rankSumPos = 0;
  for (let t = 0; t < sorted.length; t += 1) {
    if (sorted[t].y === 1) rankSumPos += ranks[t];
  }

  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Expected Calibration Error over `bins` equal-width bins of claimedProbability.
 *
 * ECE = sum over non-empty bins of
 *       (bin_size / N) * |accuracy(bin) - mean_confidence(bin)|
 *
 * Empty bins are skipped entirely: they contribute no weight and no NaN.
 * Errored outcomes are excluded — an arm that crashed made no claim.
 *
 * READ CALIBRATION_FOOTNOTE BEFORE QUOTING THIS NUMBER. A constant predictor
 * scores 0.000 here.
 */
export function expectedCalibrationError(outcomes: CaseOutcome[], bins = 10): number {
  const usable = scored(outcomes);
  if (usable.length === 0 || bins <= 0) return 0;
  return eceFromPairs(
    usable.map((o) => ({ p: clamp01(o.claimedProbability), y: o.verdictCorrect ? 1 : 0 })),
    bins,
  );
}

/** ECE over already-extracted (probability, label) pairs. */
export function eceFromPairs(pairs: Array<{ p: number; y: number }>, bins = 10): number {
  if (pairs.length === 0 || bins <= 0) return 0;

  const binConf: number[] = new Array(bins).fill(0);
  const binAcc: number[] = new Array(bins).fill(0);
  const binN: number[] = new Array(bins).fill(0);

  for (const { p, y } of pairs) {
    const q = clamp01(p);
    // q === 1 must land in the last bin, not bins + 1.
    const idx = Math.min(bins - 1, Math.floor(q * bins));
    binN[idx] += 1;
    binConf[idx] += q;
    binAcc[idx] += y;
  }

  let ece = 0;
  for (let i = 0; i < bins; i += 1) {
    if (binN[i] === 0) continue;
    const avgConf = binConf[i] / binN[i];
    const avgAcc = binAcc[i] / binN[i];
    ece += (binN[i] / pairs.length) * Math.abs(avgAcc - avgConf);
  }
  return ece;
}

/**
 * Brier score: mean squared error of claimedProbability against the 0/1
 * correctness indicator. 0 is perfect; 1 is maximally wrong-and-certain.
 *
 * READ CALIBRATION_FOOTNOTE BEFORE QUOTING THIS NUMBER.
 */
export function brierScore(outcomes: CaseOutcome[]): number {
  const usable = scored(outcomes);
  if (usable.length === 0) return 0;
  return mean(
    usable.map((o) => {
      const p = clamp01(o.claimedProbability);
      const y = o.verdictCorrect ? 1 : 0;
      return (p - y) * (p - y);
    }),
  );
}

function brierFromPairs(pairs: Array<{ p: number; y: number }>): number {
  if (pairs.length === 0) return 0;
  return mean(pairs.map(({ p, y }) => (clamp01(p) - y) * (clamp01(p) - y)));
}

// ---------------------------------------------------------------------------
// Monotone recalibration (defect B1b)
// ---------------------------------------------------------------------------

/**
 * A fitted isotonic (monotone non-decreasing) map from claimed probability to
 * calibrated probability, as a step function over pooled blocks.
 */
export interface IsotonicModel {
  /** Left edge of each pooled block, ascending. */
  x: number[];
  /** The block's calibrated value, non-decreasing. */
  y: number[];
}

/**
 * Pool-Adjacent-Violators. Fits the least-squares non-decreasing step function
 * through (x, y) pairs.
 *
 * Isotonic rather than Platt because the defect being neutralised is an
 * arbitrary MONOTONE rescale, and isotonic is exactly the family that absorbs
 * every such rescale — Platt would only absorb the logistic ones, leaving a
 * residual that still depends on the offset.
 */
export function fitIsotonic(points: Array<{ x: number; y: number }>): IsotonicModel {
  if (points.length === 0) return { x: [], y: [] };

  const sorted = [...points].sort((a, b) => a.x - b.x);

  // STEP 1 — pool by DISTINCT x first.
  //
  // Skipping this is a real bug, not an optimisation: points sharing an x
  // arrive in arbitrary label order, and running PAVA over them directly
  // fabricates several blocks at the same x with different values. The council
  // is the worst case — its score is nearly constant, so almost every point
  // shares an x — and `applyIsotonic` would then return the highest of those
  // spurious blocks instead of the observed accuracy at that x.
  const xs: number[] = [];
  const sumY: number[] = [];
  const count: number[] = [];
  for (const pt of sorted) {
    if (xs.length > 0 && xs[xs.length - 1] === pt.x) {
      sumY[sumY.length - 1] += pt.y;
      count[count.length - 1] += 1;
    } else {
      xs.push(pt.x);
      sumY.push(pt.y);
      count.push(1);
    }
  }

  // STEP 2 — weighted pool-adjacent-violators. Merge while the previous block's
  // mean exceeds this one's; that is the adjacent-violator condition.
  const blockX: number[] = [];
  const blockSum: number[] = [];
  const blockN: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    blockX.push(xs[i]);
    blockSum.push(sumY[i]);
    blockN.push(count[i]);
    while (
      blockSum.length > 1 &&
      blockSum[blockSum.length - 2] / blockN[blockN.length - 2] >
        blockSum[blockSum.length - 1] / blockN[blockN.length - 1]
    ) {
      const s = blockSum.pop() as number;
      const c = blockN.pop() as number;
      blockX.pop();
      blockSum[blockSum.length - 1] += s;
      blockN[blockN.length - 1] += c;
    }
  }

  return {
    x: blockX,
    y: blockSum.map((s, i) => s / blockN[i]),
  };
}

/** Apply a fitted isotonic model. Clamped at both ends; empty model is identity. */
export function applyIsotonic(model: IsotonicModel, x: number): number {
  if (model.x.length === 0) return clamp01(x);
  // Last block whose left edge is <= x; below the first edge, use the first.
  let lo = 0;
  let hi = model.x.length - 1;
  if (x < model.x[0]) return clamp01(model.y[0]);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (model.x[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return clamp01(model.y[lo]);
}

/**
 * Which cross-fitting fold a case belongs to: FNV-1a over the case id, mod 2.
 *
 * Hashed rather than "every other case in id order" on purpose. Golden-set ids
 * carry structure (sport prefix, tag, an index that often alternates by
 * difficulty), and index parity over a periodic ordering can land every case of
 * one kind in the same fold — which would make the held-out model useless
 * exactly where recalibration matters most. A content hash has no such
 * alignment, and is still fully deterministic.
 */
export function foldOf(caseId: string, folds = 2): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < caseId.length; i += 1) {
    h ^= caseId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Avalanche (murmur3 finaliser) BEFORE the modulo. Without it the low bit of
  // an FNV hash is dominated by the low bit of the last character, so ids that
  // alternate by trailing digit — exactly how golden ids are numbered — land
  // every case of one kind in the same fold, and the held-out model never sees
  // the region it is asked to calibrate.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) % folds;
}

export interface CalibrationBlock {
  auroc: number;
  eceRaw: number;
  eceRecalibrated: number;
  brierRaw: number;
  brierRecalibrated: number;
}

/**
 * Number of cross-fitting folds for a given sample size. 5 is the usual
 * bias/variance compromise; below 50 cases a 5-way split leaves folds too thin
 * to fit anything, and below 8 there is no honest held-out fit at all.
 */
export function foldCountFor(n: number): number {
  if (n >= 50) return 5;
  if (n >= 8) return 2;
  return 0;
}

/**
 * Raw and recalibrated calibration figures for ONE arm.
 *
 * The recalibration is K-fold CROSS-FITTED, never fitted in-sample: cases are
 * assigned to folds by a hash of the case id (see `foldOf`), each fold's
 * isotonic map is fitted on the OTHER folds, and the reported figure is
 * computed over the out-of-fold prediction for every case. Raw and
 * recalibrated therefore share the same denominator — every scored case — so
 * the pair is directly comparable rather than one number on the full set and
 * one on a half.
 *
 * BOTH arms are recalibrated, always. Recalibrating only the council would be
 * the same defect in a new costume.
 *
 * ESTIMATION FLOOR — read this before comparing eceRecalibrated to eceRaw.
 * `eceRaw` is an in-sample quantity: the arm supplies the confidence, and only
 * the bin accuracy is estimated. `eceRecalibrated` estimates BOTH the map and
 * the accuracy, out of sample, so it carries a noise floor of roughly
 * 1/sqrt(n) — measured here at about 0.08 for n = 200 and 0.02 for n = 1000,
 * even for an arm that is already perfectly calibrated. On a 125-case golden
 * set that floor is not small.
 *
 * The consequence is a rule, not a caveat: `eceRecalibrated` is for comparing
 * the TWO ARMS to each other, where both pay the same penalty and the null
 * rescale cancels out. It is NOT for asking whether one arm improved on its
 * own raw score.
 */
export function calibrationBlock(outcomes: CaseOutcome[], bins = 10): CalibrationBlock {
  const usable = scored(outcomes);
  const rawPairs = usable.map((o) => ({
    p: clamp01(o.claimedProbability),
    y: o.verdictCorrect ? 1 : 0,
  }));

  const block: CalibrationBlock = {
    auroc: auroc(outcomes),
    eceRaw: eceFromPairs(rawPairs, bins),
    eceRecalibrated: eceFromPairs(rawPairs, bins),
    brierRaw: brierFromPairs(rawPairs),
    brierRecalibrated: brierFromPairs(rawPairs),
  };
  // Too few cases for an honest held-out fit: report raw = recalibrated rather
  // than a map fitted on a handful of points.
  const k = foldCountFor(usable.length);
  if (k < 2) return block;

  const ordered = [...usable].sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const points = ordered.map((o) => ({
    x: clamp01(o.claimedProbability),
    y: o.verdictCorrect ? 1 : 0,
  }));
  const folds = ordered.map((o) => foldOf(o.caseId, k));
  // A fold that ended up empty, or one that swallowed everything, leaves some
  // model with no training data. Fall back to the raw numbers rather than
  // reporting a map fitted on nothing.
  const sizes = new Array(k).fill(0);
  folds.forEach((f) => {
    sizes[f] += 1;
  });
  if (sizes.some((size) => size === 0 || size === points.length)) return block;

  // Each fold is scored by a model fitted on every OTHER fold, so no case ever
  // contributes to the map that calibrates it.
  const models = Array.from({ length: k }, (_, fold) =>
    fitIsotonic(points.filter((_, i) => folds[i] !== fold)),
  );
  const oofPairs = points.map((pt, i) => ({
    p: applyIsotonic(models[folds[i]], pt.x),
    y: pt.y,
  }));

  block.eceRecalibrated = eceFromPairs(oofPairs, bins);
  block.brierRecalibrated = brierFromPairs(oofPairs);
  return block;
}

// ---------------------------------------------------------------------------
// Pairing (defect B2)
// ---------------------------------------------------------------------------

export interface PairedOutcomes {
  /** Baseline outcomes restricted to the intersection, ordered by caseId. */
  baseline: CaseOutcome[];
  /** Council outcomes restricted to the intersection, same order. */
  council: CaseOutcome[];
  summary: Omit<PairingSummary, 'unpairedAccuracyDelta' | 'pairedAccuracyDelta'>;
}

/**
 * The intersection of cases BOTH arms scored: present in both arms AND errored
 * in neither.
 *
 * This is the ONLY denominator on which a cross-arm delta is meaningful. An
 * arm that errors out of a hard case has not answered it, and dropping it from
 * that arm alone silently deletes a case the other arm had to face.
 */
export function pairOutcomes(
  baselineOutcomes: CaseOutcome[],
  councilOutcomes: CaseOutcome[],
): PairedOutcomes {
  const baseById = new Map<string, CaseOutcome>();
  for (const o of baselineOutcomes) baseById.set(o.caseId, o);
  const councilById = new Map<string, CaseOutcome>();
  for (const o of councilOutcomes) councilById.set(o.caseId, o);

  const unpairedCaseIds = new Set<string>();
  const erroredBaselineOnly: string[] = [];
  const erroredCouncilOnly: string[] = [];
  const erroredBoth: string[] = [];
  const pairedIds: string[] = [];

  for (const id of new Set([...baseById.keys(), ...councilById.keys()])) {
    const b = baseById.get(id);
    const c = councilById.get(id);
    if (!b || !c) {
      unpairedCaseIds.add(id);
      continue;
    }
    if (b.error && c.error) erroredBoth.push(id);
    else if (b.error) erroredBaselineOnly.push(id);
    else if (c.error) erroredCouncilOnly.push(id);
    else pairedIds.push(id);
  }

  pairedIds.sort();

  return {
    baseline: pairedIds.map((id) => baseById.get(id) as CaseOutcome),
    council: pairedIds.map((id) => councilById.get(id) as CaseOutcome),
    summary: {
      pairedCases: pairedIds.length,
      baselineAttempted: baselineOutcomes.length,
      councilAttempted: councilOutcomes.length,
      unpairedCaseIds: sortedIds(unpairedCaseIds),
      erroredCaseIds: {
        baselineOnly: erroredBaselineOnly.sort(),
        councilOnly: erroredCouncilOnly.sort(),
        both: erroredBoth.sort(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function scoreKindOf(usable: CaseOutcome[]): ArmMetrics['scoreKind'] {
  const kinds = new Set(usable.map((o) => o.scoreKind));
  if (kinds.size === 0) return 'none';
  if (kinds.size > 1) return 'mixed';
  return [...kinds][0];
}

/**
 * Aggregate ONE arm's outcomes over ITS OWN scored set.
 *
 * The returned block is stamped `basis: 'unpaired'`. These numbers describe
 * this arm in isolation and are the right thing for a single-arm run; they are
 * the WRONG thing to subtract across arms, and `compare()` will throw if you
 * hand them to it. Use `compare(baselineOutcomes, councilOutcomes, meta)` for
 * anything cross-arm.
 */
export function aggregate(outcomes: CaseOutcome[], armOverride?: ArmName): ArmMetrics {
  return aggregateOn(outcomes, 'unpaired', armOverride);
}

/**
 * Shared aggregation core. `basis` is a label describing what the caller has
 * ALREADY filtered `outcomes` down to — this function does not do the pairing
 * itself, it just records which basis it was given.
 */
function aggregateOn(
  outcomes: CaseOutcome[],
  basis: ArmMetrics['basis'],
  armOverride?: ArmName,
): ArmMetrics {
  const arm: ArmName = armOverride ?? outcomes[0]?.arm ?? 'baseline';
  const n = outcomes.length;
  const usable = scored(outcomes);
  const errored = n - usable.length;

  const perVerdict = {} as ArmMetrics['perVerdict'];
  let f1Sum = 0;
  for (const cls of VERDICT_CLASSES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let support = 0;
    for (const o of usable) {
      const isExpected = o.expectedVerdict === cls;
      const isActual = o.actualVerdict === cls;
      if (isExpected) support += 1;
      if (isExpected && isActual) tp += 1;
      else if (!isExpected && isActual) fp += 1;
      else if (isExpected && !isActual) fn += 1;
    }
    // safeDiv keeps a zero-support / never-predicted class at 0 instead of NaN.
    const precision = safeDiv(tp, tp + fp);
    const recall = safeDiv(tp, tp + fn);
    const f1 = f1From(precision, recall);
    perVerdict[cls] = { precision, recall, f1, support };
    f1Sum += f1;
  }
  // Macro-F1 always divides by the full class count, so a class with zero
  // support contributes 0 and drags the macro score down. That is the point:
  // an arm that never predicts INCONCLUSIVE should not be rewarded for it.
  const macroF1 = VERDICT_CLASSES.length === 0 ? 0 : f1Sum / VERDICT_CLASSES.length;

  const accuracyByDifficulty = {} as ArmMetrics['accuracyByDifficulty'];
  for (const band of DIFFICULTIES) {
    const inBand = usable.filter((o) => o.difficulty === band);
    accuracyByDifficulty[band] = {
      n: inBand.length,
      accuracy: safeDiv(inBand.filter((o) => o.verdictCorrect).length, inBand.length),
    };
  }

  const calibration = calibrationBlock(usable);

  return {
    arm,
    basis,
    n,
    scoredN: usable.length,
    verdictAccuracy: safeDiv(usable.filter((o) => o.verdictCorrect).length, usable.length),
    macroF1,
    perVerdict,
    meanRulePrecision: mean(usable.map((o) => o.rulePrecision)),
    meanRuleRecall: mean(usable.map((o) => o.ruleRecall)),
    meanRuleF1: mean(usable.map((o) => o.ruleF1)),
    auroc: calibration.auroc,
    eceRaw: calibration.eceRaw,
    eceRecalibrated: calibration.eceRecalibrated,
    brierRaw: calibration.brierRaw,
    brierRecalibrated: calibration.brierRecalibrated,
    accuracyByDifficulty,
    // Latency and call counts include errored cases: a timeout still cost
    // wall-clock time and, usually, tokens.
    meanLatencyMs: mean(outcomes.map((o) => o.latencyMs)),
    totalModelCalls: outcomes.reduce((sum, o) => sum + o.modelCalls, 0),
    errorRate: safeDiv(errored, n),
    scoreKind: scoreKindOf(usable),
  };
}

/** Project a full unpaired ArmMetrics down to the small non-deltable block. */
function unpairedFigures(m: ArmMetrics): UnpairedArmFigures {
  return {
    scoredN: m.scoredN,
    verdictAccuracy: m.verdictAccuracy,
    macroF1: m.macroF1,
    meanRuleF1: m.meanRuleF1,
    auroc: m.auroc,
    eceRaw: m.eceRaw,
    brierRaw: m.brierRaw,
    accuracyByDifficulty: m.accuracyByDifficulty,
  };
}

export interface PairedAggregation {
  baseline: ArmMetrics;
  council: ArmMetrics;
  paired: PairedOutcomes;
  summary: PairingSummary;
}

/**
 * Aggregate BOTH arms over the paired intersection, attaching each arm's own
 * unpaired figures as a clearly-labelled sub-block.
 *
 * Every headline field on the returned metrics is on the intersection. The
 * per-arm figures survive only inside `.unpaired`, which has no `perVerdict`
 * and no delta anywhere in the report — there is nothing to subtract.
 */
export function aggregatePaired(
  baselineOutcomes: CaseOutcome[],
  councilOutcomes: CaseOutcome[],
): PairedAggregation {
  const paired = pairOutcomes(baselineOutcomes, councilOutcomes);

  const baselineUnpaired = aggregate(baselineOutcomes, 'baseline');
  const councilUnpaired = aggregate(councilOutcomes, 'council');

  const baseline = aggregateOn(paired.baseline, 'paired', 'baseline');
  const council = aggregateOn(paired.council, 'paired', 'council');

  // `n` and the cost figures describe the whole run, not the intersection —
  // an errored case still burned wall-clock and tokens, and hiding it here
  // would understate the council's cost.
  baseline.n = baselineUnpaired.n;
  baseline.errorRate = baselineUnpaired.errorRate;
  baseline.meanLatencyMs = baselineUnpaired.meanLatencyMs;
  baseline.totalModelCalls = baselineUnpaired.totalModelCalls;
  baseline.unpaired = unpairedFigures(baselineUnpaired);

  council.n = councilUnpaired.n;
  council.errorRate = councilUnpaired.errorRate;
  council.meanLatencyMs = councilUnpaired.meanLatencyMs;
  council.totalModelCalls = councilUnpaired.totalModelCalls;
  council.unpaired = unpairedFigures(councilUnpaired);

  return {
    baseline,
    council,
    paired,
    summary: {
      ...paired.summary,
      unpairedAccuracyDelta:
        councilUnpaired.verdictAccuracy - baselineUnpaired.verdictAccuracy,
      pairedAccuracyDelta: council.verdictAccuracy - baseline.verdictAccuracy,
    },
  };
}

// ---------------------------------------------------------------------------
// Run metadata (SHOULD-FIX 7)
// ---------------------------------------------------------------------------

/**
 * Retrieval hit rate over the paired cases, plus any arm disagreement.
 *
 * This is a property of the RUN, not of an arm: `retrievalHit` is computed in
 * `prepareCase()` from the golden set alone, identically for both arms, so a
 * do-nothing stub arm scores the same 84.8% the council does and the "delta"
 * is 0 by construction. Reporting it as a per-arm row invited the reader to
 * treat an arithmetic identity as a finding.
 */
export function retrievalMetadata(
  paired: PairedOutcomes,
): Pick<RunMetadata, 'retrievalHitRate' | 'retrievalHitDisagreements'> {
  const disagreements: string[] = [];
  let hits = 0;
  for (let i = 0; i < paired.baseline.length; i += 1) {
    const b = paired.baseline[i];
    const c = paired.council[i];
    if (b.retrievalHit !== c.retrievalHit) disagreements.push(b.caseId);
    if (b.retrievalHit) hits += 1;
  }
  return {
    retrievalHitRate: safeDiv(hits, paired.baseline.length),
    retrievalHitDisagreements: disagreements.sort(),
  };
}

// ---------------------------------------------------------------------------
// Significance
// ---------------------------------------------------------------------------

/**
 * Exact two-sided binomial p-value for min(b, c) successes out of n = b + c
 * trials at p = 0.5.
 *
 *   p = min(1, 2 * sum_{i=0}^{min(b,c)} C(n, i) * 0.5^n)
 *
 * Computed by forward recurrence on the PMF — t_0 = 0.5^n and
 * t_{i+1} = t_i * (n - i) / (i + 1) — which never materialises C(n, i) itself,
 * so nothing overflows for any n this harness will ever see. No stats
 * dependency, no chi-squared approximation.
 */
export function exactBinomialTwoSidedP(b: number, c: number): number {
  const n = b + c;
  if (n <= 0) return 1;
  const k = Math.min(b, c);

  let tail: number;
  if (n <= 1000) {
    // 0.5^1000 is about 9.3e-302, comfortably above the double underflow limit.
    let term = Math.pow(0.5, n);
    tail = term;
    for (let i = 0; i < k; i += 1) {
      term = (term * (n - i)) / (i + 1);
      tail += term;
    }
  } else {
    // Log-space fallback so an absurdly large run still returns something sane.
    let logTerm = -n * Math.LN2;
    let acc = Math.exp(logTerm);
    for (let i = 0; i < k; i += 1) {
      logTerm += Math.log(n - i) - Math.log(i + 1);
      acc += Math.exp(logTerm);
    }
    tail = acc;
  }

  return Math.min(1, 2 * tail);
}

/**
 * McNemar's test on paired correctness, using the EXACT binomial test rather
 * than the chi-squared approximation.
 *
 * With ~125 cases the discordant count (b + c) is typically well under 30, and
 * the chi-squared approximation is unreliable in that regime — it happily
 * returns p < 0.05 for discordant splits an exact test calls coin-flip noise.
 * Since the single question this harness answers is "is the difference real or
 * is it noise", the approximation would undermine the whole deliverable.
 *
 * Only cases present in BOTH arms and errored in NEITHER are paired; an
 * unpaired or errored case carries no information about which arm is better.
 * This function was already correctly paired before the B2 fix and its maths
 * is unchanged.
 */
export function mcnemarExactTest(
  baselineOutcomes: CaseOutcome[],
  councilOutcomes: CaseOutcome[],
): McNemarResult {
  const baselineById = new Map<string, CaseOutcome>();
  for (const o of baselineOutcomes) baselineById.set(o.caseId, o);

  let b = 0;
  let c = 0;
  for (const councilOutcome of councilOutcomes) {
    const baselineOutcome = baselineById.get(councilOutcome.caseId);
    if (!baselineOutcome) continue;
    if (baselineOutcome.error || councilOutcome.error) continue;
    if (baselineOutcome.verdictCorrect && !councilOutcome.verdictCorrect) b += 1;
    else if (!baselineOutcome.verdictCorrect && councilOutcome.verdictCorrect) c += 1;
  }

  const pValue = exactBinomialTwoSidedP(b, c);
  return { b, c, pValue, significant: pValue < 0.05 };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface CompareMeta {
  goldenVersion: string;
  sports: SportId[];
  generatedAt?: string;
  /** Hash of everything that changes the answers. See ./fingerprint.ts. */
  configFingerprint?: string;
  /** Outcomes served from the resume cache, per arm. */
  cacheHits?: { baseline: number; council: number };
}

/**
 * Build the final ComparisonReport from RAW per-arm outcomes.
 *
 * It takes outcomes rather than metrics on purpose (defect B2). The old
 * signature accepted two pre-aggregated ArmMetrics and trusted them to be
 * comparable; they were not, because each had been computed on its own
 * post-error denominator. There is now no way to inject per-arm denominators:
 * the pairing happens in here.
 *
 * The `verdict` field is the honest part, and it stays honest: COUNCIL_BETTER
 * requires BOTH a positive accuracy delta AND a significant McNemar result. A
 * positive delta that fails significance is reported as
 * NO_SIGNIFICANT_DIFFERENCE, because that is what it is. Softening this would
 * turn the harness into a rubber stamp and defeat its only purpose. The delta
 * feeding that rule is now the PAIRED delta.
 */
export function compare(
  baselineOutcomes: CaseOutcome[],
  councilOutcomes: CaseOutcome[],
  meta: CompareMeta,
): ComparisonReport {
  const agg = aggregatePaired(baselineOutcomes, councilOutcomes);
  const { baseline, council, paired, summary } = agg;

  const significance = mcnemarExactTest(baselineOutcomes, councilOutcomes);

  const regressions: string[] = [];
  const fixes: string[] = [];
  for (let i = 0; i < paired.baseline.length; i += 1) {
    const b = paired.baseline[i];
    const c = paired.council[i];
    if (b.verdictCorrect && !c.verdictCorrect) regressions.push(c.caseId);
    else if (!b.verdictCorrect && c.verdictCorrect) fixes.push(c.caseId);
  }
  regressions.sort();
  fixes.sort();

  // THE headline delta. Paired, by construction — there is no other kind here.
  const accuracyDelta = summary.pairedAccuracyDelta;

  let verdict: ComparisonReport['verdict'];
  if (accuracyDelta > 0 && significance.significant) verdict = 'COUNCIL_BETTER';
  else if (accuracyDelta < 0 && significance.significant) verdict = 'COUNCIL_WORSE';
  else verdict = 'NO_SIGNIFICANT_DIFFERENCE';

  const retrieval = retrievalMetadata(paired);

  const caveats = [CALIBRATION_FOOTNOTE, SCORE_KIND_FOOTNOTE, RECALIBRATION_FOOTNOTE];
  const droppedForErrors =
    summary.erroredCaseIds.baselineOnly.length +
    summary.erroredCaseIds.councilOnly.length +
    summary.erroredCaseIds.both.length;
  if (droppedForErrors > 0 || summary.unpairedCaseIds.length > 0) {
    caveats.push(
      `${droppedForErrors} case(s) were dropped from the headline numbers because at least ` +
        `one arm errored on them, and ${summary.unpairedCaseIds.length} case(s) were run by ` +
        `only one arm. Every figure above is on the ${summary.pairedCases}-case intersection. ` +
        `On per-arm denominators the accuracy delta would read ` +
        `${(summary.unpairedAccuracyDelta * 100).toFixed(1)}pp instead of ` +
        `${(summary.pairedAccuracyDelta * 100).toFixed(1)}pp; that difference is an artefact ` +
        `of the differing denominators, not an effect of the council.`,
    );
  }
  if (retrieval.retrievalHitDisagreements.length > 0) {
    caveats.push(
      `prepareCase() is NOT deterministic: the two arms disagreed about retrievalHit on ` +
        `${retrieval.retrievalHitDisagreements.length} case(s). Treat this comparison as invalid ` +
        `until that is fixed.`,
    );
  }
  if ((meta.cacheHits?.baseline ?? 0) + (meta.cacheHits?.council ?? 0) > 0) {
    caveats.push(
      `Resume cache served ${meta.cacheHits?.baseline ?? 0} baseline and ` +
        `${meta.cacheHits?.council ?? 0} council outcome(s); those cases were NOT re-invoked ` +
        `in this run. They are only reusable because their recorded config fingerprint matched ` +
        `(${meta.configFingerprint ?? 'unknown'}).`,
    );
  }

  return {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    goldenVersion: meta.goldenVersion,
    sports: meta.sports,
    baseline,
    council,
    pairing: summary,
    runMetadata: {
      ...retrieval,
      configFingerprint: meta.configFingerprint,
      cacheHits: meta.cacheHits,
    },
    delta: {
      verdictAccuracy: accuracyDelta,
      macroF1: council.macroF1 - baseline.macroF1,
      meanRuleF1: council.meanRuleF1 - baseline.meanRuleF1,
      auroc: council.auroc - baseline.auroc,
      eceRaw: council.eceRaw - baseline.eceRaw,
      eceRecalibrated: council.eceRecalibrated - baseline.eceRecalibrated,
      brierRaw: council.brierRaw - baseline.brierRaw,
      meanLatencyMs: council.meanLatencyMs - baseline.meanLatencyMs,
      totalModelCalls: council.totalModelCalls - baseline.totalModelCalls,
    },
    significance: {
      baselineOnlyCorrect: significance.b,
      councilOnlyCorrect: significance.c,
      pValue: significance.pValue,
      significant: significance.significant,
    },
    regressions,
    fixes,
    verdict,
    caveats,
  };
}

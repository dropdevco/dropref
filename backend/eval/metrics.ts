/**
 * Pure scoring maths for the RefCheck AI accuracy harness.
 *
 * HARD CONSTRAINT: this module performs no I/O — no network, no fs, no env.
 * Every function here is deterministic given its arguments, which is what makes
 * the harness testable offline (see __tests__/metrics.test.ts) and what makes
 * its claims auditable: if the numbers are wrong, they are wrong in a way you
 * can reproduce on a hand-written fixture.
 */

import type { SportId, Verdict } from '../../types/contract';
import type { CouncilResult } from '../council/types';
import { ruleRef } from '../council/rule-ref';
import type {
  ArmMetrics,
  CaseOutcome,
  ComparisonReport,
  GoldenCase,
} from './types';

/** The three verdict classes, in a fixed order so reports are stable. */
export const VERDICT_CLASSES: Verdict[] = ['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE'];

/** The three difficulty bands, in a fixed order. */
export const DIFFICULTIES: GoldenCase['difficulty'][] = ['easy', 'medium', 'hard'];

export type ArmName = 'baseline' | 'council';

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
 */
function scored(outcomes: CaseOutcome[]): CaseOutcome[] {
  return outcomes.filter((o) => !o.error);
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
    difficulty: golden.difficulty,
    tag: golden.tag,
    latencyMs: result.processingMs,
    modelCalls: result.totalCalls,
  };
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
 */
export function expectedCalibrationError(outcomes: CaseOutcome[], bins = 10): number {
  const usable = scored(outcomes);
  if (usable.length === 0 || bins <= 0) return 0;

  const binConf: number[] = new Array(bins).fill(0);
  const binAcc: number[] = new Array(bins).fill(0);
  const binN: number[] = new Array(bins).fill(0);

  for (const o of usable) {
    const p = clamp01(o.claimedProbability);
    // p === 1 must land in the last bin, not bins + 1.
    const idx = Math.min(bins - 1, Math.floor(p * bins));
    binN[idx] += 1;
    binConf[idx] += p;
    binAcc[idx] += o.verdictCorrect ? 1 : 0;
  }

  let ece = 0;
  for (let i = 0; i < bins; i += 1) {
    if (binN[i] === 0) continue;
    const avgConf = binConf[i] / binN[i];
    const avgAcc = binAcc[i] / binN[i];
    ece += (binN[i] / usable.length) * Math.abs(avgAcc - avgConf);
  }
  return ece;
}

/**
 * Brier score: mean squared error of claimedProbability against the 0/1
 * correctness indicator. 0 is perfect; 1 is maximally wrong-and-certain.
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

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Aggregate per-case outcomes for one arm into headline metrics. */
export function aggregate(outcomes: CaseOutcome[], armOverride?: ArmName): ArmMetrics {
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

  return {
    arm,
    n,
    verdictAccuracy: safeDiv(usable.filter((o) => o.verdictCorrect).length, usable.length),
    macroF1,
    perVerdict,
    meanRulePrecision: mean(usable.map((o) => o.rulePrecision)),
    meanRuleRecall: mean(usable.map((o) => o.ruleRecall)),
    meanRuleF1: mean(usable.map((o) => o.ruleF1)),
    retrievalHitRate: safeDiv(usable.filter((o) => o.retrievalHit).length, usable.length),
    ece: expectedCalibrationError(usable),
    brier: brierScore(usable),
    accuracyByDifficulty,
    // Latency and call counts include errored cases: a timeout still cost
    // wall-clock time and, usually, tokens.
    meanLatencyMs: mean(outcomes.map((o) => o.latencyMs)),
    totalModelCalls: outcomes.reduce((sum, o) => sum + o.modelCalls, 0),
    errorRate: safeDiv(errored, n),
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
}

/**
 * Build the final ComparisonReport.
 *
 * The `verdict` field is the honest part, and it stays honest: COUNCIL_BETTER
 * requires BOTH a positive accuracy delta AND a significant McNemar result. A
 * positive delta that fails significance is reported as
 * NO_SIGNIFICANT_DIFFERENCE, because that is what it is. Softening this would
 * turn the harness into a rubber stamp and defeat its only purpose.
 */
export function compare(
  baseline: ArmMetrics,
  council: ArmMetrics,
  baselineOutcomes: CaseOutcome[],
  councilOutcomes: CaseOutcome[],
  meta: CompareMeta,
): ComparisonReport {
  const significance = mcnemarExactTest(baselineOutcomes, councilOutcomes);

  const baselineById = new Map<string, CaseOutcome>();
  for (const o of baselineOutcomes) baselineById.set(o.caseId, o);

  const regressions: string[] = [];
  const fixes: string[] = [];
  for (const councilOutcome of councilOutcomes) {
    const baselineOutcome = baselineById.get(councilOutcome.caseId);
    if (!baselineOutcome) continue;
    if (baselineOutcome.error || councilOutcome.error) continue;
    if (baselineOutcome.verdictCorrect && !councilOutcome.verdictCorrect) {
      regressions.push(councilOutcome.caseId);
    } else if (!baselineOutcome.verdictCorrect && councilOutcome.verdictCorrect) {
      fixes.push(councilOutcome.caseId);
    }
  }
  regressions.sort();
  fixes.sort();

  const accuracyDelta = council.verdictAccuracy - baseline.verdictAccuracy;

  let verdict: ComparisonReport['verdict'];
  if (accuracyDelta > 0 && significance.significant) verdict = 'COUNCIL_BETTER';
  else if (accuracyDelta < 0 && significance.significant) verdict = 'COUNCIL_WORSE';
  else verdict = 'NO_SIGNIFICANT_DIFFERENCE';

  return {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    goldenVersion: meta.goldenVersion,
    sports: meta.sports,
    baseline,
    council,
    delta: {
      verdictAccuracy: accuracyDelta,
      macroF1: council.macroF1 - baseline.macroF1,
      meanRuleF1: council.meanRuleF1 - baseline.meanRuleF1,
      ece: council.ece - baseline.ece,
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
  };
}

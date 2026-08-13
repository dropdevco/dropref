/**
 * Tests for backend/eval/metrics.ts.
 *
 * This repo has no test runner, and adding one is out of scope, so this is a
 * plain script:  npx tsx backend/eval/__tests__/metrics.test.ts
 * It exits non-zero if any assertion fails.
 *
 * Everything here is offline: no network, no env, no fs.
 */

import type { Verdict } from '../../../types/contract';
import type { CouncilResult } from '../../council/types';
import type { CaseOutcome, GoldenCase } from '../types';
import {
  aggregate,
  brierScore,
  compare,
  exactBinomialTwoSidedP,
  expectedCalibrationError,
  mcnemarExactTest,
  ruleSetScores,
  scoreCase,
} from '../metrics';

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

let passed = 0;
const failures: string[] = [];

function ok(condition: boolean, message: string): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${message}`);
  } else {
    failures.push(message);
    console.error(`  FAIL  ${message}`);
  }
}

function eq(actual: unknown, expected: unknown, message: string): void {
  ok(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  );
}

function close(actual: number, expected: number, epsilon: number, message: string): void {
  const good = Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon;
  ok(good, `${message} (expected ~${expected}, got ${actual}, tol ${epsilon})`);
}

function section(name: string): void {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;

function outcome(partial: Partial<CaseOutcome>): CaseOutcome {
  seq += 1;
  return {
    caseId: partial.caseId ?? `case-${seq}`,
    arm: partial.arm ?? 'baseline',
    expectedVerdict: partial.expectedVerdict ?? 'FAIR_CALL',
    actualVerdict: partial.actualVerdict ?? 'FAIR_CALL',
    verdictCorrect:
      partial.verdictCorrect ??
      (partial.expectedVerdict ?? 'FAIR_CALL') === (partial.actualVerdict ?? 'FAIR_CALL'),
    expectedRuleRefs: partial.expectedRuleRefs ?? [],
    actualRuleRefs: partial.actualRuleRefs ?? [],
    rulePrecision: partial.rulePrecision ?? 1,
    ruleRecall: partial.ruleRecall ?? 1,
    ruleF1: partial.ruleF1 ?? 1,
    retrievalHit: partial.retrievalHit ?? true,
    claimedProbability: partial.claimedProbability ?? 0.5,
    difficulty: partial.difficulty ?? 'medium',
    tag: partial.tag ?? 'test',
    error: partial.error,
    latencyMs: partial.latencyMs ?? 100,
    modelCalls: partial.modelCalls ?? 1,
  };
}

/** n outcomes for a given (expected, actual) verdict pair. */
function confusionCell(expected: Verdict, actual: Verdict, n: number): CaseOutcome[] {
  return Array.from({ length: n }, () =>
    outcome({ expectedVerdict: expected, actualVerdict: actual }),
  );
}

function goldenCase(partial: Partial<GoldenCase>): GoldenCase {
  return {
    id: partial.id ?? 'soccer-test-001',
    sport: partial.sport ?? 'soccer',
    observation: partial.observation ?? 'A defender slides in from the side.',
    originalCall: partial.originalCall ?? null,
    expectedVerdict: partial.expectedVerdict ?? 'BAD_CALL',
    expectedRuleRefs: partial.expectedRuleRefs ?? [],
    difficulty: partial.difficulty ?? 'medium',
    tag: partial.tag ?? 'test',
    rationale: partial.rationale ?? 'because',
  };
}

function councilResult(partial: Partial<CouncilResult>): CouncilResult {
  return {
    verdict: partial.verdict ?? 'BAD_CALL',
    confidence: partial.confidence ?? 'HIGH',
    reasoning: partial.reasoning ?? 'reasoning',
    rulesCited: partial.rulesCited ?? [],
    accuracyScore: partial.accuracyScore ?? 0.8,
    reliability: partial.reliability ?? 'TRUSTWORTHY',
    stage: partial.stage ?? 'panel',
    agreement: partial.agreement ?? {
      consensusRatio: 1,
      verdictEntropy: 0,
      citationAgreement: 1,
      meanProbability: 0.8,
      distribution: { FAIR_CALL: 0, BAD_CALL: 3, INCONCLUSIVE: 0 },
    },
    opinions: partial.opinions ?? [],
    debate: partial.debate ?? [],
    failedSeats: partial.failedSeats ?? [],
    totalCalls: partial.totalCalls ?? 3,
    processingMs: partial.processingMs ?? 1234,
  };
}

/** Paired outcomes for two arms with a prescribed correctness pattern. */
function pairedOutcomes(pattern: Array<[boolean, boolean]>): {
  baseline: CaseOutcome[];
  council: CaseOutcome[];
} {
  const baseline: CaseOutcome[] = [];
  const council: CaseOutcome[] = [];
  pattern.forEach(([baseCorrect, councilCorrect], i) => {
    const id = `pair-${String(i).padStart(3, '0')}`;
    baseline.push(
      outcome({
        caseId: id,
        arm: 'baseline',
        expectedVerdict: 'BAD_CALL',
        actualVerdict: baseCorrect ? 'BAD_CALL' : 'FAIR_CALL',
      }),
    );
    council.push(
      outcome({
        caseId: id,
        arm: 'council',
        expectedVerdict: 'BAD_CALL',
        actualVerdict: councilCorrect ? 'BAD_CALL' : 'FAIR_CALL',
      }),
    );
  });
  return { baseline, council };
}

function repeat<T>(item: T, n: number): T[] {
  return Array.from({ length: n }, () => item);
}

// ===========================================================================
// 1. Macro-F1 on a hand-computed confusion matrix
// ===========================================================================

section('macro-F1 on a hand-computed confusion matrix');

/*
 * 10 outcomes, laid out as (expected -> actual):
 *
 *   FAIR_CALL    -> FAIR_CALL     x3
 *   FAIR_CALL    -> BAD_CALL      x1
 *   BAD_CALL     -> BAD_CALL      x2
 *   BAD_CALL     -> FAIR_CALL     x1
 *   INCONCLUSIVE -> INCONCLUSIVE  x2
 *   INCONCLUSIVE -> BAD_CALL      x1
 *
 * Support: FAIR_CALL 4, BAD_CALL 3, INCONCLUSIVE 3.
 * Predicted counts: FAIR_CALL 4, BAD_CALL 4, INCONCLUSIVE 2.
 *
 * Worked by hand:
 *   FAIR_CALL     tp=3 fp=1 fn=1 -> P=3/4=0.75   R=3/4=0.75   F1=0.75      = 3/4
 *   BAD_CALL      tp=2 fp=2 fn=1 -> P=2/4=0.5    R=2/3        F1=4/7 ~ 0.571428571
 *   INCONCLUSIVE  tp=2 fp=0 fn=1 -> P=2/2=1.0    R=2/3        F1=4/5=0.8
 *
 *   macro-F1 = (3/4 + 4/7 + 4/5) / 3
 *            = (105/140 + 80/140 + 112/140) / 3
 *            = (297/140) / 3
 *            = 99/140
 *            = 0.7071428571428571
 *
 *   accuracy = (3 + 2 + 2) / 10 = 0.7
 */
const HAND_MACRO_F1 = 99 / 140; // 0.7071428571428571

const confusion: CaseOutcome[] = [
  ...confusionCell('FAIR_CALL', 'FAIR_CALL', 3),
  ...confusionCell('FAIR_CALL', 'BAD_CALL', 1),
  ...confusionCell('BAD_CALL', 'BAD_CALL', 2),
  ...confusionCell('BAD_CALL', 'FAIR_CALL', 1),
  ...confusionCell('INCONCLUSIVE', 'INCONCLUSIVE', 2),
  ...confusionCell('INCONCLUSIVE', 'BAD_CALL', 1),
];

const confusionMetrics = aggregate(confusion, 'council');

close(confusionMetrics.macroF1, HAND_MACRO_F1, 1e-12, 'macro-F1 equals hand-computed 99/140');
close(confusionMetrics.macroF1, 0.7071428571428571, 1e-12, 'macro-F1 equals 0.7071428571428571');
close(confusionMetrics.verdictAccuracy, 0.7, 1e-12, 'verdict accuracy equals hand-computed 0.7');
close(confusionMetrics.perVerdict.FAIR_CALL.f1, 0.75, 1e-12, 'FAIR_CALL F1 = 0.75');
close(confusionMetrics.perVerdict.BAD_CALL.f1, 4 / 7, 1e-12, 'BAD_CALL F1 = 4/7');
close(confusionMetrics.perVerdict.INCONCLUSIVE.f1, 0.8, 1e-12, 'INCONCLUSIVE F1 = 0.8');
close(confusionMetrics.perVerdict.BAD_CALL.precision, 0.5, 1e-12, 'BAD_CALL precision = 0.5');
close(confusionMetrics.perVerdict.INCONCLUSIVE.recall, 2 / 3, 1e-12, 'INCONCLUSIVE recall = 2/3');
eq(confusionMetrics.perVerdict.FAIR_CALL.support, 4, 'FAIR_CALL support = 4');
eq(confusionMetrics.perVerdict.BAD_CALL.support, 3, 'BAD_CALL support = 3');
eq(confusionMetrics.perVerdict.INCONCLUSIVE.support, 3, 'INCONCLUSIVE support = 3');

// ===========================================================================
// 2. A zero-support class yields 0, not NaN
// ===========================================================================

section('zero-support class yields 0, not NaN');

// Only FAIR_CALL and BAD_CALL appear; INCONCLUSIVE has zero support and is
// never predicted. Its precision/recall/F1 must be 0, and macro-F1 must be
// (1 + 1 + 0) / 3 = 2/3 rather than NaN.
const noInconclusive: CaseOutcome[] = [
  ...confusionCell('FAIR_CALL', 'FAIR_CALL', 4),
  ...confusionCell('BAD_CALL', 'BAD_CALL', 4),
];
const zeroSupport = aggregate(noInconclusive, 'baseline');

eq(zeroSupport.perVerdict.INCONCLUSIVE.support, 0, 'INCONCLUSIVE support is 0');
eq(zeroSupport.perVerdict.INCONCLUSIVE.precision, 0, 'zero-support precision is 0');
eq(zeroSupport.perVerdict.INCONCLUSIVE.recall, 0, 'zero-support recall is 0');
eq(zeroSupport.perVerdict.INCONCLUSIVE.f1, 0, 'zero-support F1 is 0');
ok(!Number.isNaN(zeroSupport.perVerdict.INCONCLUSIVE.f1), 'zero-support F1 is not NaN');
ok(!Number.isNaN(zeroSupport.macroF1), 'macro-F1 is not NaN with a zero-support class');
close(zeroSupport.macroF1, 2 / 3, 1e-12, 'macro-F1 = (1 + 1 + 0)/3 = 2/3');

// An entirely empty outcome list must also produce zeros rather than NaN.
const empty = aggregate([], 'council');
ok(
  !Number.isNaN(empty.macroF1) &&
    !Number.isNaN(empty.verdictAccuracy) &&
    !Number.isNaN(empty.errorRate) &&
    !Number.isNaN(empty.meanLatencyMs),
  'aggregate([]) produces no NaN anywhere in the headline numbers',
);
eq(empty.verdictAccuracy, 0, 'aggregate([]) accuracy is 0');
eq(empty.accuracyByDifficulty.hard.accuracy, 0, 'aggregate([]) hard-band accuracy is 0');

// ===========================================================================
// 3. Expected Calibration Error
// ===========================================================================

section('expected calibration error');

// Perfectly calibrated: two populated bins whose observed accuracy exactly
// matches their claimed confidence. 10 @ p=0.9 with 9 correct; 10 @ p=0.5 with
// 5 correct. Every non-empty bin contributes |acc - conf| = 0.
const calibrated: CaseOutcome[] = [
  ...repeat(0, 9).map(() =>
    outcome({ claimedProbability: 0.9, expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }),
  ),
  ...repeat(0, 1).map(() =>
    outcome({ claimedProbability: 0.9, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
  ),
  ...repeat(0, 5).map(() =>
    outcome({ claimedProbability: 0.5, expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }),
  ),
  ...repeat(0, 5).map(() =>
    outcome({ claimedProbability: 0.5, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
  ),
];
close(expectedCalibrationError(calibrated), 0, 1e-12, 'ECE of a perfectly calibrated set is ~0');

// Maximally overconfident: claims certainty (p = 1.0) and is wrong every time.
const overconfident: CaseOutcome[] = repeat(0, 20).map(() =>
  outcome({ claimedProbability: 1, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
);
close(expectedCalibrationError(overconfident), 1, 1e-12, 'ECE of a maximally overconfident set is ~1');

// p = 1.0 must land in the last bin, not overflow past it.
eq(expectedCalibrationError([]), 0, 'ECE of an empty set is 0 (not NaN)');

// Errored outcomes made no claim and must be excluded.
const withErrors: CaseOutcome[] = [
  ...calibrated,
  outcome({ claimedProbability: 1, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL', error: 'boom' }),
];
close(expectedCalibrationError(withErrors), 0, 1e-12, 'ECE ignores errored outcomes');

// ===========================================================================
// 4. Brier score
// ===========================================================================

section('brier score');

const alwaysRightCertain: CaseOutcome[] = repeat(0, 12).map(() =>
  outcome({ claimedProbability: 1, expectedVerdict: 'FAIR_CALL', actualVerdict: 'FAIR_CALL' }),
);
const alwaysWrongCertain: CaseOutcome[] = repeat(0, 12).map(() =>
  outcome({ claimedProbability: 1, expectedVerdict: 'FAIR_CALL', actualVerdict: 'BAD_CALL' }),
);

close(brierScore(alwaysRightCertain), 0, 1e-12, 'Brier of always-correct-and-certain is 0');
close(brierScore(alwaysWrongCertain), 1, 1e-12, 'Brier of always-wrong-and-certain is 1');
eq(brierScore([]), 0, 'Brier of an empty set is 0 (not NaN)');

// A coin-flip claim of 0.5 always scores 0.25 regardless of the outcome.
const hedged: CaseOutcome[] = [
  outcome({ claimedProbability: 0.5, expectedVerdict: 'FAIR_CALL', actualVerdict: 'FAIR_CALL' }),
  outcome({ claimedProbability: 0.5, expectedVerdict: 'FAIR_CALL', actualVerdict: 'BAD_CALL' }),
];
close(brierScore(hedged), 0.25, 1e-12, 'Brier of a p=0.5 hedge is 0.25');

// ===========================================================================
// 5. McNemar — exact two-sided binomial test, against known values
// ===========================================================================

section('mcnemar exact two-sided binomial test');

// b = 10, c = 0, n = 10, k = 0:
//   p = 2 * C(10,0) * 0.5^10 = 2 * (1/1024) = 2/1024 = 0.001953125
close(exactBinomialTwoSidedP(10, 0), 0.001953125, 1e-15, 'exact p for b=10,c=0 is 0.001953125');
close(exactBinomialTwoSidedP(10, 0), 0.00195, 1e-5, 'exact p for b=10,c=0 rounds to ~0.00195');
ok(exactBinomialTwoSidedP(10, 0) < 0.05, 'b=10,c=0 is significant');

// b = 5, c = 5, n = 10, k = 5:
//   sum_{i=0..5} C(10,i) = 1 + 10 + 45 + 120 + 210 + 252 = 638
//   p = 2 * 638/1024 = 1.24609375 -> clamped to exactly 1
eq(exactBinomialTwoSidedP(5, 5), 1, 'exact p for b=5,c=5 is exactly 1.0 (clamped)');
ok(exactBinomialTwoSidedP(5, 5) >= 0.05, 'b=5,c=5 is NOT significant');

// b = 0, c = 0: nothing to test.
eq(exactBinomialTwoSidedP(0, 0), 1, 'exact p for b=0,c=0 is 1');

// Symmetry: direction must not change the p-value.
eq(exactBinomialTwoSidedP(0, 10), exactBinomialTwoSidedP(10, 0), 'p-value is symmetric in b and c');

// A couple more textbook values.
// b=6,c=0: p = 2 * 1/64 = 0.03125 (significant)
close(exactBinomialTwoSidedP(6, 0), 0.03125, 1e-15, 'exact p for b=6,c=0 is 0.03125');
// b=5,c=0: p = 2 * 1/32 = 0.0625 (NOT significant — the chi-squared
// approximation would wrongly call this one significant at p~0.025)
close(exactBinomialTwoSidedP(5, 0), 0.0625, 1e-15, 'exact p for b=5,c=0 is 0.0625, not significant');
// b=8,c=1: n=9,k=1 -> p = 2 * (1 + 9)/512 = 20/512 = 0.0390625
close(exactBinomialTwoSidedP(8, 1), 0.0390625, 1e-15, 'exact p for b=8,c=1 is 0.0390625');

// Now through the paired-outcome entry point.
const strongRegression = pairedOutcomes([
  ...repeat<[boolean, boolean]>([true, false], 10), // b = 10
  ...repeat<[boolean, boolean]>([true, true], 5),
]);
const mcRegression = mcnemarExactTest(strongRegression.baseline, strongRegression.council);
eq(mcRegression.b, 10, 'mcnemarExactTest counts b = 10');
eq(mcRegression.c, 0, 'mcnemarExactTest counts c = 0');
close(mcRegression.pValue, 0.001953125, 1e-15, 'paired b=10,c=0 gives p = 0.001953125');
eq(mcRegression.significant, true, 'paired b=10,c=0 is significant');

const evenSplit = pairedOutcomes([
  ...repeat<[boolean, boolean]>([true, false], 5), // b = 5
  ...repeat<[boolean, boolean]>([false, true], 5), // c = 5
]);
const mcEven = mcnemarExactTest(evenSplit.baseline, evenSplit.council);
eq(mcEven.b, 5, 'mcnemarExactTest counts b = 5');
eq(mcEven.c, 5, 'mcnemarExactTest counts c = 5');
eq(mcEven.pValue, 1, 'paired b=5,c=5 gives p = 1');
eq(mcEven.significant, false, 'paired b=5,c=5 is NOT significant');

const noDisagreement = pairedOutcomes(repeat<[boolean, boolean]>([true, true], 30));
const mcNone = mcnemarExactTest(noDisagreement.baseline, noDisagreement.council);
eq(mcNone.b, 0, 'no disagreement gives b = 0');
eq(mcNone.c, 0, 'no disagreement gives c = 0');
eq(mcNone.pValue, 1, 'b=0,c=0 gives p = 1');
eq(mcNone.significant, false, 'b=0,c=0 is NOT significant');

// Errored and unpaired cases carry no signal and must not be counted.
const dirty = pairedOutcomes(repeat<[boolean, boolean]>([true, false], 4));
dirty.council[0].error = 'timeout';
dirty.baseline.push(outcome({ caseId: 'orphan', arm: 'baseline', actualVerdict: 'BAD_CALL' }));
const mcDirty = mcnemarExactTest(dirty.baseline, dirty.council);
eq(mcDirty.b, 3, 'errored and unpaired cases are excluded from the discordant counts');

// ===========================================================================
// 6. Empty-expectedRuleRefs precision/recall convention
// ===========================================================================

section('empty expectedRuleRefs convention');

const bothEmpty = ruleSetScores([], []);
eq(bothEmpty.precision, 1, 'expected=[] actual=[] -> precision 1');
eq(bothEmpty.recall, 1, 'expected=[] actual=[] -> recall 1');
eq(bothEmpty.f1, 1, 'expected=[] actual=[] -> F1 1');

const spurious = ruleSetScores([], ['Law 12.1 :: handball']);
eq(spurious.precision, 0, 'expected=[] with a citation -> precision 0');
eq(spurious.recall, 1, 'expected=[] with a citation -> recall still 1');
eq(spurious.f1, 0, 'expected=[] with a citation -> F1 0');

const citedNothing = ruleSetScores(['Law 11.1 :: offside-position'], []);
eq(citedNothing.precision, 0, 'expected non-empty, actual=[] -> precision 0');
eq(citedNothing.recall, 0, 'expected non-empty, actual=[] -> recall 0');
eq(citedNothing.f1, 0, 'expected non-empty, actual=[] -> F1 0');
ok(
  !Number.isNaN(citedNothing.precision) && !Number.isNaN(citedNothing.f1),
  'empty actual set produces no NaN',
);

const partial = ruleSetScores(
  ['Law 12.1 :: reckless-challenge', 'Law 12.3 :: dissent'],
  ['Law 12.1 :: reckless-challenge', 'Law 11.1 :: offside-position'],
);
close(partial.precision, 0.5, 1e-12, 'partial overlap precision = 1/2');
close(partial.recall, 0.5, 1e-12, 'partial overlap recall = 1/2');
close(partial.f1, 0.5, 1e-12, 'partial overlap F1 = 1/2');

// Same convention, exercised end to end through scoreCase.
const inconclusiveCase = goldenCase({
  id: 'soccer-inconclusive-001',
  expectedVerdict: 'INCONCLUSIVE',
  expectedRuleRefs: [],
});
const citedNothingOutcome = scoreCase(
  inconclusiveCase,
  councilResult({ verdict: 'INCONCLUSIVE', rulesCited: [], accuracyScore: 0.6 }),
  ['Law 12.1 :: careless-challenge'],
  'council',
);
eq(citedNothingOutcome.rulePrecision, 1, 'scoreCase: empty expected + no citation -> precision 1');
eq(citedNothingOutcome.ruleRecall, 1, 'scoreCase: empty expected -> recall 1');
eq(citedNothingOutcome.ruleF1, 1, 'scoreCase: empty expected + no citation -> F1 1');
eq(citedNothingOutcome.retrievalHit, true, 'scoreCase: empty expected -> retrievalHit true');
eq(citedNothingOutcome.verdictCorrect, true, 'scoreCase: matching verdict is correct');
eq(citedNothingOutcome.arm, 'council', 'scoreCase stamps the arm');
eq(citedNothingOutcome.claimedProbability, 0.6, 'scoreCase carries accuracyScore through');
eq(citedNothingOutcome.modelCalls, 3, 'scoreCase carries totalCalls through');

const fabricatedOutcome = scoreCase(
  inconclusiveCase,
  councilResult({
    verdict: 'INCONCLUSIVE',
    rulesCited: [{ code: 'Law 12.1', title: 'Handball', text: '...' }],
  }),
  [],
  'council',
);
eq(fabricatedOutcome.rulePrecision, 0, 'scoreCase: empty expected + fabricated citation -> precision 0');
eq(fabricatedOutcome.ruleRecall, 1, 'scoreCase: empty expected + fabricated citation -> recall 1');
eq(fabricatedOutcome.ruleF1, 0, 'scoreCase: empty expected + fabricated citation -> F1 0');

// ===========================================================================
// 7. Rule comparison is on ruleRef(), never on the bare code
// ===========================================================================

section('rule comparison uses ruleRef, not bare code');

// Soccer reuses "Law 12.1" for five distinct rules. Citing the WRONG Law 12.1
// must score as a miss; comparing bare codes would score it as a perfect hit.
const recklessCase = goldenCase({
  id: 'soccer-foul-007',
  expectedVerdict: 'BAD_CALL',
  expectedRuleRefs: ['Law 12.1 :: reckless-challenge'],
});
const wrongLaw121 = scoreCase(
  recklessCase,
  councilResult({
    verdict: 'BAD_CALL',
    rulesCited: [{ code: 'Law 12.1', title: 'Handball', text: '...' }],
  }),
  ['Law 12.1 :: reckless-challenge'],
  'council',
);
eq(wrongLaw121.rulePrecision, 0, 'same code, different rule -> precision 0 (not a false hit)');
eq(wrongLaw121.ruleRecall, 0, 'same code, different rule -> recall 0');
eq(wrongLaw121.retrievalHit, true, 'retrieval DID surface the right rule — adjudication is the bug');

const rightLaw121 = scoreCase(
  recklessCase,
  councilResult({
    verdict: 'BAD_CALL',
    rulesCited: [{ code: 'Law 12.1', title: 'Reckless challenge', text: '...' }],
  }),
  ['Law 12.1 :: handball'],
  'council',
);
eq(rightLaw121.rulePrecision, 1, 'correct rule ref -> precision 1');
eq(rightLaw121.ruleRecall, 1, 'correct rule ref -> recall 1');
eq(
  rightLaw121.retrievalHit,
  false,
  'shortlist lacked the expected ref -> retrievalHit false (a retrieval bug, distinct from adjudication)',
);

// ===========================================================================
// 8. compare() — the honesty rule
// ===========================================================================

section('compare(): a positive delta without significance is NOT a win');

function reportFor(pattern: Array<[boolean, boolean]>) {
  const { baseline, council } = pairedOutcomes(pattern);
  return compare(
    aggregate(baseline, 'baseline'),
    aggregate(council, 'council'),
    baseline,
    council,
    { goldenVersion: 'test@1', sports: ['soccer'], generatedAt: '2026-01-01T00:00:00.000Z' },
  );
}

// Positive delta (+10pp) but only 6 discordant cases: b=2, c=4.
//   p = 2 * (C(6,0) + C(6,1) + C(6,2)) / 64 = 2 * 22/64 = 0.6875 -> not significant.
const noisyWin = reportFor([
  ...repeat<[boolean, boolean]>([true, true], 8),
  ...repeat<[boolean, boolean]>([false, true], 4), // c = 4
  ...repeat<[boolean, boolean]>([true, false], 2), // b = 2
  ...repeat<[boolean, boolean]>([false, false], 6),
]);
close(noisyWin.delta.verdictAccuracy, 0.1, 1e-12, 'noisy run has a positive +10pp accuracy delta');
close(noisyWin.significance.pValue, 0.6875, 1e-12, 'noisy run p = 0.6875');
eq(noisyWin.significance.significant, false, 'noisy run is not significant');
eq(
  noisyWin.verdict,
  'NO_SIGNIFICANT_DIFFERENCE',
  'positive delta + non-significant => NO_SIGNIFICANT_DIFFERENCE (never COUNCIL_BETTER)',
);
eq(noisyWin.fixes.length, 4, 'noisy run lists 4 fixes');
eq(noisyWin.regressions.length, 2, 'noisy run lists 2 regressions');

// Genuine, significant improvement: b=0, c=10.
const realWin = reportFor([
  ...repeat<[boolean, boolean]>([false, true], 10), // c = 10
  ...repeat<[boolean, boolean]>([true, true], 5),
  ...repeat<[boolean, boolean]>([false, false], 5),
]);
ok(realWin.delta.verdictAccuracy > 0, 'real win has a positive accuracy delta');
close(realWin.significance.pValue, 0.001953125, 1e-15, 'real win p = 0.001953125');
eq(realWin.verdict, 'COUNCIL_BETTER', 'positive delta + significant => COUNCIL_BETTER');

// Significant regression: b=10, c=0. This is what makes the CLI exit non-zero.
const realLoss = reportFor([
  ...repeat<[boolean, boolean]>([true, false], 10), // b = 10
  ...repeat<[boolean, boolean]>([true, true], 5),
  ...repeat<[boolean, boolean]>([false, false], 5),
]);
ok(realLoss.delta.verdictAccuracy < 0, 'real loss has a negative accuracy delta');
eq(realLoss.verdict, 'COUNCIL_WORSE', 'negative delta + significant => COUNCIL_WORSE');
eq(realLoss.regressions.length, 10, 'real loss lists 10 regressions');
eq(realLoss.fixes.length, 0, 'real loss lists no fixes');

// Identical arms: no delta, nothing to test.
const tie = reportFor(repeat<[boolean, boolean]>([true, true], 20));
eq(tie.verdict, 'NO_SIGNIFICANT_DIFFERENCE', 'identical arms => NO_SIGNIFICANT_DIFFERENCE');
eq(tie.significance.pValue, 1, 'identical arms => p = 1');

// ===========================================================================
// 9. aggregate() bookkeeping
// ===========================================================================

section('aggregate() bookkeeping');

const mixed: CaseOutcome[] = [
  outcome({ difficulty: 'easy', expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL', latencyMs: 100, modelCalls: 3 }),
  outcome({ difficulty: 'easy', expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL', latencyMs: 200, modelCalls: 3 }),
  outcome({ difficulty: 'hard', expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL', latencyMs: 300, modelCalls: 3 }),
  outcome({ difficulty: 'hard', expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL', latencyMs: 400, modelCalls: 1, error: 'HTTP 429' }),
];
const mixedMetrics = aggregate(mixed, 'council');

eq(mixedMetrics.n, 4, 'n counts every attempted case, errors included');
close(mixedMetrics.errorRate, 0.25, 1e-12, 'errorRate = 1/4');
close(mixedMetrics.verdictAccuracy, 2 / 3, 1e-12, 'accuracy excludes the errored case (2 of 3)');
eq(mixedMetrics.accuracyByDifficulty.easy.n, 2, 'easy band counts 2 scored cases');
eq(mixedMetrics.accuracyByDifficulty.hard.n, 1, 'hard band excludes the errored case');
eq(mixedMetrics.accuracyByDifficulty.medium.n, 0, 'medium band is empty');
eq(mixedMetrics.accuracyByDifficulty.medium.accuracy, 0, 'empty difficulty band accuracy is 0, not NaN');
eq(mixedMetrics.totalModelCalls, 10, 'totalModelCalls sums every case, errors included');
close(mixedMetrics.meanLatencyMs, 250, 1e-12, 'meanLatencyMs averages every case, errors included');
eq(mixedMetrics.arm, 'council', 'arm label is carried through');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(60)}`);
if (failures.length === 0) {
  console.log(`ALL TESTS PASSED — ${passed} assertions`);
  console.log('='.repeat(60));
  process.exit(0);
} else {
  console.error(`${failures.length} FAILED, ${passed} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('='.repeat(60));
  process.exit(1);
}

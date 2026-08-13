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
  aggregatePaired,
  auroc,
  brierScore,
  calibrationBlock,
  compare,
  exactBinomialTwoSidedP,
  expectedCalibrationError,
  mcnemarExactTest,
  pairOutcomes,
  retrievalMetadata,
  ruleSetScores,
  scoreCase,
} from '../metrics';
import type { RunFingerprint } from '../fingerprint';
import { buildRunFingerprint, diffFingerprints, fingerprintDigest } from '../fingerprint';
import { cacheEntryReusable, cacheKey, makeCacheEntry, staleSiblings, emptyCache } from '../cache';

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
    scoreKind:
      partial.scoreKind ??
      ((partial.arm ?? 'baseline') === 'baseline' ? 'self_probability' : 'council_formula'),
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

// compare() now takes RAW OUTCOMES and does the pairing itself. It is no longer
// possible to hand it two per-arm-denominator ArmMetrics blocks — that was the
// injection point for defect B2.
function reportFor(pattern: Array<[boolean, boolean]>) {
  const { baseline, council } = pairedOutcomes(pattern);
  return compare(baseline, council, {
    goldenVersion: 'test@1',
    sports: ['soccer'],
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
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

// ===========================================================================
// 10. DEFECT B2 — headline metrics must use the PAIRED INTERSECTION
// ===========================================================================

section('B2: paired intersection vs per-arm denominators');

/*
 * The reviewer's demonstration, reproduced exactly.
 *
 * 125 synthetic cases. The council genuinely fixes 9 and breaks 1, and
 * ADDITIONALLY errors on 15 cases that BOTH arms would have got wrong.
 *
 *   70 cases  both correct
 *    1 case   baseline correct, council wrong        (the regression)
 *    9 cases  baseline wrong,   council correct      (the fixes)
 *   30 cases  both wrong
 *   15 cases  baseline wrong,   council ERRORED      (dropped from council)
 *  ---
 *  125 total; 110 of them scored by BOTH arms.
 *
 * Per-arm denominators (the defect):
 *   baseline 71/125 = 56.8%   council 79/110 = 71.8%   delta +15.0pp
 * Paired intersection (the truth):
 *   baseline 71/110 = 64.5%   council 79/110 = 71.8%   delta  +7.3pp
 *
 * The 15 errored cases were all cases the baseline got WRONG, so deleting them
 * from the council's denominator alone deletes 15 hard cases from one arm and
 * not the other. That is where the extra 7.7pp comes from — it is arithmetic,
 * not adjudication.
 */
function b2Scenario(): { baseline: CaseOutcome[]; council: CaseOutcome[] } {
  const baseline: CaseOutcome[] = [];
  const council: CaseOutcome[] = [];
  let idx = 0;

  const add = (
    count: number,
    baseCorrect: boolean,
    councilCorrect: boolean,
    councilErrored = false,
  ): void => {
    for (let i = 0; i < count; i += 1) {
      const id = `b2-${String(idx).padStart(3, '0')}`;
      idx += 1;
      baseline.push(
        outcome({
          caseId: id,
          arm: 'baseline',
          expectedVerdict: 'BAD_CALL',
          actualVerdict: baseCorrect ? 'BAD_CALL' : 'FAIR_CALL',
          claimedProbability: 0.62,
        }),
      );
      council.push(
        outcome({
          caseId: id,
          arm: 'council',
          expectedVerdict: 'BAD_CALL',
          actualVerdict: councilCorrect ? 'BAD_CALL' : 'FAIR_CALL',
          claimedProbability: 0.86,
          error: councilErrored ? 'HTTP 502 upstream' : undefined,
        }),
      );
    }
  };

  add(70, true, true);
  add(1, true, false);
  add(9, false, true);
  add(30, false, false);
  add(15, false, false, true); // council errors; baseline would have missed anyway
  return { baseline, council };
}

const b2 = b2Scenario();

eq(b2.baseline.length, 125, 'B2 fixture has 125 baseline cases');
eq(b2.council.length, 125, 'B2 fixture has 125 council cases');

// --- The REPORTED (wrong) figures, i.e. what per-arm denominators produce ---
const b2BaselineOwn = aggregate(b2.baseline, 'baseline');
const b2CouncilOwn = aggregate(b2.council, 'council');

eq(b2BaselineOwn.basis, 'unpaired', 'aggregate() stamps basis = unpaired');
eq(b2CouncilOwn.basis, 'unpaired', 'aggregate() stamps basis = unpaired for the council too');
eq(b2BaselineOwn.scoredN, 125, 'baseline scored all 125 on its own denominator');
eq(b2CouncilOwn.scoredN, 110, 'council scored only 110 on its own denominator');
close(b2BaselineOwn.verdictAccuracy, 0.568, 5e-4, 'per-arm baseline accuracy is 56.8%');
close(b2CouncilOwn.verdictAccuracy, 0.718, 5e-4, 'per-arm council accuracy is 71.8%');
close(
  b2CouncilOwn.verdictAccuracy - b2BaselineOwn.verdictAccuracy,
  0.15,
  5e-4,
  'per-arm denominators produce the FLATTERED +15.0pp delta (this is the defect)',
);

// --- The HONEST figures, over the intersection ---
const b2Paired = aggregatePaired(b2.baseline, b2.council);

eq(b2Paired.baseline.basis, 'paired', 'aggregatePaired stamps baseline basis = paired');
eq(b2Paired.council.basis, 'paired', 'aggregatePaired stamps council basis = paired');
eq(b2Paired.summary.pairedCases, 110, 'the intersection is 110 cases');
eq(b2Paired.baseline.scoredN, 110, 'baseline headline denominator is the intersection (110)');
eq(b2Paired.council.scoredN, 110, 'council headline denominator is the intersection (110)');
eq(
  b2Paired.summary.erroredCaseIds.councilOnly.length,
  15,
  '15 cases were dropped because only the council errored on them',
);
close(b2Paired.baseline.verdictAccuracy, 0.645, 5e-4, 'PAIRED baseline accuracy is 64.5%');
close(b2Paired.council.verdictAccuracy, 0.718, 5e-4, 'PAIRED council accuracy is 71.8%');
close(
  b2Paired.summary.pairedAccuracyDelta,
  0.073,
  5e-4,
  'PAIRED delta is the honest +7.3pp, not +15.0pp',
);
close(
  b2Paired.summary.unpairedAccuracyDelta,
  0.15,
  5e-4,
  'the wrong +15.0pp figure is retained, quarantined in pairing.unpairedAccuracyDelta',
);
close(
  b2Paired.summary.unpairedAccuracyDelta - b2Paired.summary.pairedAccuracyDelta,
  0.077,
  1e-3,
  'the per-arm denominators were inventing exactly 7.7pp of improvement',
);

// The per-arm figures survive, but only inside `.unpaired`, with no delta.
close(
  b2Paired.council.unpaired?.verdictAccuracy ?? -1,
  0.718,
  5e-4,
  'council .unpaired.verdictAccuracy still exposes the own-denominator number',
);
close(
  b2Paired.baseline.unpaired?.verdictAccuracy ?? -1,
  0.568,
  5e-4,
  'baseline .unpaired.verdictAccuracy still exposes the own-denominator number',
);
eq(b2Paired.baseline.unpaired?.scoredN, 125, 'baseline .unpaired records ITS OWN denominator (125)');
eq(b2Paired.council.unpaired?.scoredN, 110, 'council .unpaired records ITS OWN denominator (110)');
ok(
  b2Paired.baseline.unpaired !== undefined && b2Paired.council.unpaired !== undefined,
  'both paired blocks carry a clearly-separated .unpaired sub-block',
);

// Cost figures still describe the WHOLE run — an errored case still cost money.
eq(b2Paired.council.n, 125, 'paired council block still reports 125 cases ATTEMPTED');
close(b2Paired.council.errorRate, 15 / 125, 1e-12, 'paired council block still reports errorRate');

// --- The report the harness would actually print ---
const b2Report = compare(b2.baseline, b2.council, {
  goldenVersion: 'b2@1',
  sports: ['soccer'],
  generatedAt: '2026-01-01T00:00:00.000Z',
});

close(
  b2Report.delta.verdictAccuracy,
  0.073,
  5e-4,
  'compare() headline delta is the PAIRED +7.3pp',
);
ok(
  Math.abs(b2Report.delta.verdictAccuracy - 0.15) > 0.07,
  'compare() headline delta is NOT the +15.0pp per-arm figure',
);
eq(b2Report.fixes.length, 9, 'B2 scenario lists 9 fixes');
eq(b2Report.regressions.length, 1, 'B2 scenario lists 1 regression');
eq(b2Report.significance.councilOnlyCorrect, 9, 'McNemar c = 9');
eq(b2Report.significance.baselineOnlyCorrect, 1, 'McNemar b = 1');
// b=1, c=9, n=10, k=1: p = 2 * (C(10,0) + C(10,1)) / 1024 = 22/1024
close(b2Report.significance.pValue, 22 / 1024, 1e-12, 'B2 scenario p = 22/1024 = 0.021484375');
eq(b2Report.verdict, 'COUNCIL_BETTER', 'B2 scenario is still a genuine, significant win');
eq(b2Report.baseline.basis, 'paired', 'report.baseline is on the paired basis');
eq(b2Report.council.basis, 'paired', 'report.council is on the paired basis');
eq(b2Report.pairing.pairedCases, 110, 'report records the 110-case intersection');
ok(
  b2Report.caveats.some((c) => c.includes('15.0pp') && c.includes('7.3pp')),
  'report caveats name BOTH the per-arm and paired deltas so the gap cannot be missed',
);

// macroF1, accuracyByDifficulty, ECE and Brier share the same denominator fix.
close(
  b2Paired.baseline.macroF1,
  aggregate(b2Paired.paired.baseline, 'baseline').macroF1,
  1e-12,
  'paired macroF1 is computed over the intersection, not the arm own set',
);
ok(
  Math.abs(b2Paired.baseline.macroF1 - b2BaselineOwn.macroF1) > 1e-9,
  'paired macroF1 genuinely differs from the per-arm macroF1 here',
);
ok(
  Math.abs(b2Paired.baseline.eceRaw - b2BaselineOwn.eceRaw) > 1e-9,
  'paired ECE genuinely differs from the per-arm ECE here',
);
eq(
  b2Paired.baseline.accuracyByDifficulty.medium.n,
  110,
  'accuracyByDifficulty is on the intersection too',
);

// Nothing is dropped when both arms score everything.
const cleanPair = pairedOutcomes(repeat<[boolean, boolean]>([true, false], 10));
const cleanPaired = pairOutcomes(cleanPair.baseline, cleanPair.council);
eq(cleanPaired.summary.pairedCases, 10, 'a clean run pairs every case');
eq(cleanPaired.summary.unpairedCaseIds.length, 0, 'a clean run has no unpaired cases');
const cleanAgg = aggregatePaired(cleanPair.baseline, cleanPair.council);
close(
  cleanAgg.summary.pairedAccuracyDelta,
  cleanAgg.summary.unpairedAccuracyDelta,
  1e-12,
  'with no errors the paired and per-arm deltas coincide (the fix changes nothing)',
);

// A case only one arm ran is unpaired, not silently half-counted.
const orphaned = pairedOutcomes(repeat<[boolean, boolean]>([true, true], 4));
orphaned.baseline.push(outcome({ caseId: 'solo-1', arm: 'baseline', actualVerdict: 'FAIR_CALL' }));
const orphanPaired = pairOutcomes(orphaned.baseline, orphaned.council);
eq(orphanPaired.summary.pairedCases, 4, 'a one-arm-only case is excluded from the intersection');
eq(orphanPaired.summary.unpairedCaseIds[0], 'solo-1', 'the one-arm-only case is named in the report');

// ===========================================================================
// 11. DEFECT B3 — the resume cache key must cover everything that changes the answer
// ===========================================================================

section('B3: cache key covers every input that changes the answer');

function fingerprint(overrides: Partial<RunFingerprint> = {}): RunFingerprint {
  return {
    harnessVersion: 'eval-2',
    k: 5,
    seats: [
      { id: 'seat-1', model: 'google/gemini-2.5-flash', role: 'literalist', temperature: 0.1 },
      { id: 'seat-2', model: 'openai/gpt-4o-mini', role: 'prosecutor', temperature: 0.4 },
      { id: 'seat-3', model: 'anthropic/claude-haiku-4.5', role: 'defender', temperature: 0.4 },
    ],
    chair: { id: 'chair', model: 'anthropic/claude-opus-4.5', role: 'chair', temperature: 0.1 },
    consensusThreshold: 0.75,
    minProbability: 0.65,
    quorum: 2,
    accuracyWeights: { consensus: 0.4, probability: 0.3, entropy: 0.2, citation: 0.1 },
    councilSourceHash: 'aaaa0000',
    councilEnvHash: 'bbbb1111',
    incomplete: false,
    ...overrides,
  };
}

const baseFp = fingerprint();
const baseComponents = {
  arm: 'council' as const,
  caseId: 'soccer-001',
  goldenVersion: 'soccer@1.0.0',
  fingerprint: baseFp,
};
const baseKey = cacheKey(baseComponents);

// The old key was exactly this, and it is what let a changed arm be skipped.
const OLD_STYLE_KEY = 'council::soccer-001::soccer@1.0.0';
ok(baseKey.startsWith(OLD_STYLE_KEY), 'the key still begins with arm::case::goldenVersion');
ok(baseKey !== OLD_STYLE_KEY, 'the key is NO LONGER just arm::case::goldenVersion');

// Each of these, alone, must change the key.
const KEY_INPUTS: Array<[string, Partial<RunFingerprint>]> = [
  ['k', { k: 7 }],
  ['seat model slug', { seats: fingerprint().seats?.map((s, i) => (i === 0 ? { ...s, model: 'x/other' } : s)) ?? null }],
  ['seat temperature', { seats: fingerprint().seats?.map((s, i) => (i === 0 ? { ...s, temperature: 0.9 } : s)) ?? null }],
  ['seat roster size', { seats: (fingerprint().seats ?? []).slice(0, 2) }],
  ['chair model', { chair: { id: 'chair', model: 'x/cheaper', role: 'chair', temperature: 0.1 } }],
  ['consensusThreshold', { consensusThreshold: 0.66 }],
  ['minProbability', { minProbability: 0.5 }],
  ['quorum', { quorum: 3 }],
  ['ACCURACY_WEIGHTS', { accuracyWeights: { consensus: 0.5, probability: 0.2, entropy: 0.2, citation: 0.1 } }],
  ['backend/council/** source hash', { councilSourceHash: 'cccc2222' }],
  ['COUNCIL_* env', { councilEnvHash: 'dddd3333' }],
  ['harness version', { harnessVersion: 'eval-3' }],
];

for (const [label, override] of KEY_INPUTS) {
  const changedKey = cacheKey({ ...baseComponents, fingerprint: fingerprint(override) });
  ok(changedKey !== baseKey, `changing ${label} changes the cache key`);
}

// Identical inputs must still hit — a cache that never hits is not a cache.
eq(
  cacheKey({ ...baseComponents, fingerprint: fingerprint() }),
  baseKey,
  'an identical configuration produces an identical key (the cache still resumes)',
);

// --- The reviewer's demonstration: change the answers AND k, then re-run ---
const cachedOutcome = outcome({
  caseId: 'soccer-001',
  arm: 'council',
  expectedVerdict: 'BAD_CALL',
  actualVerdict: 'BAD_CALL',
});
const storedEntry = makeCacheEntry(baseComponents, cachedOutcome, '2026-01-01T00:00:00.000Z');

const sameConfig = cacheEntryReusable(storedEntry, baseComponents);
eq(sameConfig.reusable, true, 'an entry stored under the SAME config is reusable');

// k 5 -> 7 AND a new council build: exactly the scenario that silently reused.
const movedComponents = {
  ...baseComponents,
  fingerprint: fingerprint({ k: 7, councilSourceHash: 'ffff9999' }),
};
const movedDecision = cacheEntryReusable(storedEntry, movedComponents);
eq(
  movedDecision.reusable,
  false,
  'changing k AND the council source INVALIDATES the entry (it is no longer silently reused)',
);
ok(
  !movedDecision.reusable && movedDecision.changed.some((line) => line.startsWith('k:')),
  'the refusal names `k` as a changed component',
);
ok(
  !movedDecision.reusable &&
    movedDecision.changed.some((line) => line.startsWith('councilSourceHash:')),
  'the refusal names the council source hash as a changed component',
);
ok(
  !movedDecision.reusable && movedDecision.reason.length > 0,
  'the refusal carries a human-readable reason for stderr',
);
ok(
  cacheKey(movedComponents) !== storedEntry.key,
  'the moved configuration does not even map to the stored key',
);

// The stale entry is still discoverable, so the re-run can be announced.
const cacheFile = emptyCache();
cacheFile.entries[storedEntry.key] = storedEntry;
const stale = staleSiblings(cacheFile, movedComponents);
eq(stale.length, 1, 'the stale entry is found and reported rather than silently ignored');
eq(stale[0].fingerprintDigest, fingerprintDigest(baseFp), 'the stale entry names the OLD fingerprint');

// A pre-B3 cache (a bare CaseOutcome with no provenance) must be refused.
const legacy = cacheEntryReusable(cachedOutcome as unknown, baseComponents);
eq(legacy.reusable, false, 'a pre-B3 cache entry with no recorded fingerprint is refused');

// A hand-edited cache file must be refused.
const tampered = { ...storedEntry, fingerprintDigest: 'deadbeefdeadbeef' };
eq(
  cacheEntryReusable(tampered, baseComponents).reusable,
  false,
  'an entry whose digest does not match its own fingerprint is refused',
);
const misfiled = { ...storedEntry, outcome: { ...cachedOutcome, caseId: 'soccer-999' } };
eq(
  cacheEntryReusable(misfiled, baseComponents).reusable,
  false,
  'an entry whose outcome belongs to another case is refused',
);
eq(
  cacheEntryReusable(storedEntry, { ...baseComponents, goldenVersion: 'soccer@2.0.0' }).reusable,
  false,
  'a golden-set version bump still invalidates the entry',
);
eq(
  cacheEntryReusable(storedEntry, { ...baseComponents, arm: 'baseline' }).reusable,
  false,
  'an entry from the other arm is refused',
);

// diffFingerprints is what makes a refusal explainable.
const diff = diffFingerprints(baseFp, fingerprint({ k: 7 }));
eq(diff.length, 1, 'diffFingerprints reports exactly the fields that changed');
ok(diff[0].startsWith('k: 5 -> 7'), 'diffFingerprints renders the change readably');

// buildRunFingerprint degrades honestly when the council config is unavailable.
const degraded = buildRunFingerprint({
  k: 5,
  config: null,
  accuracyWeights: null,
  councilDir: '/definitely/not/a/real/dir',
  env: {},
});
eq(degraded.incomplete, true, 'a fingerprint missing the roster/weights is flagged incomplete');
eq(degraded.seats, null, 'an unresolvable roster is recorded as null, not as a default guess');
ok(
  degraded.councilSourceHash.length > 0,
  'an unreadable council directory still yields a source-hash sentinel rather than throwing',
);

// ===========================================================================
// 12. DEFECT B1a — AUROC is invariant under the council's monotone rescale
// ===========================================================================

section('B1: AUROC null-transform invariance vs ECE drift');

/**
 * The null experiment. The council answers IDENTICALLY to the baseline — zero
 * added information — and differs ONLY in how it reports its confidence:
 *
 *     p_council = 0.7 + 0.3 * p_baseline
 *
 * which is what the accuracyScore composite degenerates to when a 3-seat panel
 * at consensusThreshold 0.75 settles unanimously (consensusRatio pinned to 1,
 * verdictEntropy pinned to 0).
 *
 * An unbiased comparison MUST report a delta of 0 here. AUROC does, exactly,
 * because it depends only on the ranking and the transform is strictly
 * increasing. ECE does not: it drifts, and around 90% base accuracy it changes
 * sign, which is how it ends up "showing" a calibration improvement that is
 * nothing but an offset interacting with the base rate.
 */
const NULL_TRANSFORM = (p: number): number => 0.7 + 0.3 * p;

function nullExperiment(trueAccuracy: number, n = 200): {
  baseline: CaseOutcome[];
  council: CaseOutcome[];
} {
  // Deterministic LCG — no dependency, identical on every machine.
  let state = 12345;
  const rand = (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
  const nCorrect = Math.round(trueAccuracy * n);
  const baseline: CaseOutcome[] = [];
  const council: CaseOutcome[] = [];
  for (let i = 0; i < n; i += 1) {
    const correct = i < nCorrect;
    // A partially informative score: correct cases skew high, but the ranges
    // overlap, so AUROC is strictly between 0.5 and 1.
    const u = rand();
    const p = correct ? 0.35 + 0.65 * u : 0.65 * u;
    const id = `null-${String(i).padStart(3, '0')}`;
    baseline.push(
      outcome({
        caseId: id,
        arm: 'baseline',
        expectedVerdict: 'BAD_CALL',
        actualVerdict: correct ? 'BAD_CALL' : 'FAIR_CALL',
        claimedProbability: p,
        scoreKind: 'self_probability',
      }),
    );
    council.push(
      outcome({
        caseId: id,
        arm: 'council',
        expectedVerdict: 'BAD_CALL',
        // IDENTICAL answer. Only the reported confidence is rescaled.
        actualVerdict: correct ? 'BAD_CALL' : 'FAIR_CALL',
        claimedProbability: NULL_TRANSFORM(p),
        scoreKind: 'council_formula',
      }),
    );
  }
  return { baseline, council };
}

console.log('  null experiment (council answers IDENTICALLY, only the scale differs):');
console.log('    true acc    dAUROC      dECEraw     dECErecal');
let sawEceDrift = false;
let sawEceSignFlip = false;
let firstEceSign = 0;
for (const acc of [0.5, 0.7, 0.8, 0.9, 0.95]) {
  const { baseline, council } = nullExperiment(acc);
  const bm = aggregate(baseline, 'baseline');
  const cm = aggregate(council, 'council');
  const dAuroc = cm.auroc - bm.auroc;
  const dEce = cm.eceRaw - bm.eceRaw;
  const dEceRecal = cm.eceRecalibrated - bm.eceRecalibrated;
  console.log(
    `    ${(acc * 100).toFixed(0).padStart(3)}%       ` +
      `${dAuroc >= 0 ? '+' : ''}${dAuroc.toFixed(4)}     ` +
      `${dEce >= 0 ? '+' : ''}${dEce.toFixed(4)}     ` +
      `${dEceRecal >= 0 ? '+' : ''}${dEceRecal.toFixed(4)}`,
  );

  close(dAuroc, 0, 1e-12, `AUROC delta is EXACTLY 0 at ${(acc * 100).toFixed(0)}% base accuracy`);
  ok(
    bm.auroc > 0.5 && bm.auroc < 1,
    `AUROC at ${(acc * 100).toFixed(0)}% is non-degenerate (${bm.auroc.toFixed(4)}), so the invariance is not trivial`,
  );
  if (Math.abs(dEce) > 0.01) sawEceDrift = true;
  if (firstEceSign === 0) firstEceSign = Math.sign(dEce);
  else if (Math.sign(dEce) !== 0 && Math.sign(dEce) !== firstEceSign) sawEceSignFlip = true;
}
ok(sawEceDrift, 'ECE DOES move on the null data (it is measuring the rescale, not the council)');
ok(
  sawEceSignFlip,
  'the ECE delta even CHANGES SIGN across base rates — it is an interaction, not a property of the council',
);

// Direct, minimal statement of the invariance.
const monotoneProbe: CaseOutcome[] = [
  outcome({ caseId: 'm-1', claimedProbability: 0.1, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
  outcome({ caseId: 'm-2', claimedProbability: 0.4, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
  outcome({ caseId: 'm-3', claimedProbability: 0.6, expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }),
  outcome({ caseId: 'm-4', claimedProbability: 0.9, expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }),
];
const rescaled = monotoneProbe.map((o) => ({
  ...o,
  claimedProbability: NULL_TRANSFORM(o.claimedProbability),
}));
eq(auroc(monotoneProbe), 1, 'perfectly separating scores give AUROC 1');
eq(auroc(rescaled), auroc(monotoneProbe), 'AUROC is unchanged by p -> 0.7 + 0.3p');
ok(
  expectedCalibrationError(rescaled) !== expectedCalibrationError(monotoneProbe),
  'ECE IS changed by the same rescale',
);

// AUROC basics.
const inverted = monotoneProbe.map((o) => ({ ...o, claimedProbability: 1 - o.claimedProbability }));
eq(auroc(inverted), 0, 'perfectly anti-correlated scores give AUROC 0');
eq(
  auroc([
    outcome({ caseId: 'a-1', claimedProbability: 0.5, expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }),
    outcome({ caseId: 'a-2', claimedProbability: 0.5, expectedVerdict: 'BAD_CALL', actualVerdict: 'FAIR_CALL' }),
  ]),
  0.5,
  'a constant score gives AUROC exactly 0.5 (mid-ranks, not sort order)',
);
eq(auroc([]), 0.5, 'AUROC of an empty set is 0.5, not NaN');
eq(
  auroc(repeat(0, 5).map(() => outcome({ expectedVerdict: 'BAD_CALL', actualVerdict: 'BAD_CALL' }))),
  0.5,
  'AUROC with no incorrect cases is 0.5 (not measurable), not NaN',
);

// ===========================================================================
// 13. SHOULD-FIX 6 — ECE/Brier are minimised by a useless constant predictor
// ===========================================================================

section('KNOWN BEHAVIOUR: a constant predictor wins on ECE and Brier');

/*
 * THIS IS NOT A GOOD SCORE. It is asserted here so that nobody later reads a
 * 0.000 ECE as evidence of anything.
 *
 * The constant arm always answers INCONCLUSIVE and always claims 0.20. On a
 * 125-case set where 20% of the ground truth happens to be INCONCLUSIVE it is
 * right 20% of the time — so its claimed 0.20 is PERFECTLY calibrated, ECE is
 * exactly 0.000, and Brier is 0.160. A genuinely 75%-accurate arm that says so
 * honestly scores Brier 0.188 — WORSE. The useless arm wins both calibration
 * metrics while being 55 percentage points less accurate.
 */
const CONSTANT_N = 125;
const constantArm: CaseOutcome[] = Array.from({ length: CONSTANT_N }, (_, i) =>
  outcome({
    caseId: `const-${String(i).padStart(3, '0')}`,
    arm: 'council',
    // 20% of the set is genuinely INCONCLUSIVE; the arm always says INCONCLUSIVE.
    expectedVerdict: i % 5 === 0 ? 'INCONCLUSIVE' : 'BAD_CALL',
    actualVerdict: 'INCONCLUSIVE',
    claimedProbability: 0.2,
  }),
);
// 100 rather than 125 only so that "75% accurate" is an exact integer count
// (125 * 0.75 = 93.75). Brier is a mean, so the two arms remain comparable.
const usefulArm: CaseOutcome[] = Array.from({ length: 100 }, (_, i) =>
  outcome({
    caseId: `useful-${String(i).padStart(3, '0')}`,
    arm: 'council',
    expectedVerdict: 'BAD_CALL',
    actualVerdict: i % 4 === 3 ? 'FAIR_CALL' : 'BAD_CALL', // exactly 75% correct
    claimedProbability: 0.75,
  }),
);

const constantMetrics = aggregate(constantArm, 'council');
const usefulMetrics = aggregate(usefulArm, 'council');

close(constantMetrics.verdictAccuracy, 0.2, 1e-12, 'the constant arm is only 20% accurate');
close(usefulMetrics.verdictAccuracy, 0.75, 1e-12, 'the useful arm is 75% accurate');
close(
  constantMetrics.eceRaw,
  0,
  1e-12,
  'KNOWN PATHOLOGY: the useless constant arm scores a PERFECT ECE of 0.000',
);
close(constantMetrics.brierRaw, 0.16, 1e-12, 'KNOWN PATHOLOGY: the constant arm scores Brier 0.160');
close(usefulMetrics.brierRaw, 0.1875, 1e-12, 'the genuinely 75%-accurate arm scores Brier 0.188');
ok(
  constantMetrics.brierRaw < usefulMetrics.brierRaw,
  'KNOWN PATHOLOGY: the useless arm BEATS the useful arm on Brier (0.160 < 0.188)',
);
ok(
  constantMetrics.eceRaw <= usefulMetrics.eceRaw + 1e-9,
  'KNOWN PATHOLOGY: the useless arm TIES the honest arm on ECE (both ~0.000)',
);
// AUROC is the metric that is NOT fooled: a constant score cannot discriminate.
close(
  constantMetrics.auroc,
  0.5,
  1e-12,
  'AUROC correctly scores the constant arm at chance (0.5) — this is why it is the headline',
);
// And the footnote that must ship with every report.
const footnoteReport = compare(b2.baseline, b2.council, {
  goldenVersion: 'b2@1',
  sports: ['soccer'],
  generatedAt: '2026-01-01T00:00:00.000Z',
});
ok(
  footnoteReport.caveats.some((c) => c.includes('CONSTANT predictor') && c.includes('0.000')),
  'every report carries the footnote that ECE/Brier must never be read without accuracy',
);
ok(
  footnoteReport.caveats.some((c) => c.includes('scoreKind')),
  'every report carries the footnote that the two arms emit different KINDS of probability',
);

// ===========================================================================
// 14. DEFECT B1b — out-of-fold monotone recalibration
// ===========================================================================

section('recalibration: eceRecalibrated <= eceRaw on a miscalibrated set');

/*
 * A systematically overconfident arm, of the kind an LLM actually produces:
 *   claims 0.90, is right 50% of the time  -> 0.40 of miscalibration
 *   claims 0.60, is right 30% of the time  -> 0.30 of miscalibration
 * so eceRaw ~= 0.35. A monotone map (0.60 -> 0.30, 0.90 -> 0.50) fixes it
 * entirely, and isotonic regression is exactly the family that finds it.
 *
 * The recalibration is fitted OUT OF FOLD, so this is not the trivial
 * in-sample perfection isotonic regression would otherwise hand you — and that
 * honesty has a price, asserted separately below: eceRecalibrated carries an
 * out-of-sample estimation floor of roughly 1/sqrt(n). n = 1000 here so the
 * 0.35 -> ~0.03 reduction is unambiguous; on a 125-case run the floor is much
 * larger, which is why eceRecalibrated is for comparing the two ARMS to each
 * other and not for comparing an arm to its own raw score.
 */
function miscalibrated(n = 1000): CaseOutcome[] {
  const out: CaseOutcome[] = [];
  for (let i = 0; i < n; i += 1) {
    const highGroup = i % 2 === 0;
    const withinGroup = Math.floor(i / 2);
    const correct = highGroup
      ? withinGroup % 2 === 0 // 50% correct at p = 0.90
      : withinGroup % 10 < 3; // 30% correct at p = 0.60
    out.push(
      outcome({
        caseId: `mis-${String(i).padStart(4, '0')}`,
        arm: 'council',
        expectedVerdict: 'BAD_CALL',
        actualVerdict: correct ? 'BAD_CALL' : 'FAIR_CALL',
        claimedProbability: highGroup ? 0.9 : 0.6,
      }),
    );
  }
  return out;
}

const misSet = miscalibrated();
const misCal = calibrationBlock(misSet);

console.log(
  `  miscalibrated set: eceRaw=${misCal.eceRaw.toFixed(4)} ` +
    `eceRecalibrated=${misCal.eceRecalibrated.toFixed(4)} ` +
    `brierRaw=${misCal.brierRaw.toFixed(4)} ` +
    `brierRecalibrated=${misCal.brierRecalibrated.toFixed(4)}`,
);

close(misCal.eceRaw, 0.35, 0.02, 'the synthetic set is miscalibrated by ~0.35 ECE');
ok(
  misCal.eceRecalibrated <= misCal.eceRaw,
  'eceRecalibrated <= eceRaw on a miscalibrated set',
);
ok(
  misCal.eceRecalibrated < 0.05,
  'out-of-fold isotonic recalibration removes almost all of the miscalibration (0.35 -> <0.05)',
);
ok(
  misCal.eceRecalibrated < misCal.eceRaw / 5,
  'the residual is at least 5x smaller than the raw miscalibration',
);
ok(
  misCal.brierRecalibrated <= misCal.brierRaw,
  'brierRecalibrated <= brierRaw on the same set',
);
// Recalibration is monotone, so it cannot manufacture discrimination.
close(
  misCal.auroc,
  auroc(misSet),
  1e-12,
  'recalibration does not touch AUROC — a monotone map cannot add discrimination',
);

// Both arms are recalibrated, never just one.
const misPairReport = compare(
  misSet.map((o) => ({ ...o, arm: 'baseline' as const, scoreKind: 'self_probability' as const })),
  misSet.map((o) => ({
    ...o,
    arm: 'council' as const,
    claimedProbability: NULL_TRANSFORM(o.claimedProbability),
  })),
  { goldenVersion: 'mis@1', sports: ['soccer'], generatedAt: '2026-01-01T00:00:00.000Z' },
);
ok(
  misPairReport.baseline.eceRecalibrated <= misPairReport.baseline.eceRaw &&
    misPairReport.council.eceRecalibrated <= misPairReport.council.eceRaw,
  'BOTH arms are recalibrated, not just the council',
);
close(
  misPairReport.delta.eceRecalibrated,
  0,
  0.02,
  'after recalibrating both arms, the null rescale no longer produces an ECE delta',
);
ok(
  Math.abs(misPairReport.delta.eceRaw) > Math.abs(misPairReport.delta.eceRecalibrated),
  'the RAW ECE delta on the same null data is larger than the recalibrated one',
);
eq(misPairReport.baseline.scoreKind, 'self_probability', 'the report records the baseline score kind');
eq(misPairReport.council.scoreKind, 'council_formula', 'the report records the council score kind');

// KNOWN BEHAVIOUR: eceRecalibrated has an out-of-sample estimation floor.
// An already-perfectly-calibrated arm scores eceRaw 0.000 but a NON-ZERO
// eceRecalibrated, because the recalibrated figure estimates both the map and
// the bin accuracy out of sample. This is asserted so nobody reads a non-zero
// eceRecalibrated as miscalibration, and so nobody compares the two columns as
// if they were measured the same way.
const alreadyGood = (n: number): CaseOutcome[] =>
  Array.from({ length: n }, (_, i) =>
    outcome({
      caseId: `good-${String(i).padStart(4, '0')}`,
      expectedVerdict: 'BAD_CALL',
      actualVerdict: i % 10 < 7 ? 'BAD_CALL' : 'FAIR_CALL',
      claimedProbability: 0.7,
    }),
  );
const goodBig = calibrationBlock(alreadyGood(1000));
const goodSmall = calibrationBlock(alreadyGood(125));
console.log(
  `  estimation floor on a PERFECTLY calibrated arm: ` +
    `n=1000 eceRaw=${goodBig.eceRaw.toFixed(4)} eceRecal=${goodBig.eceRecalibrated.toFixed(4)} | ` +
    `n=125 eceRaw=${goodSmall.eceRaw.toFixed(4)} eceRecal=${goodSmall.eceRecalibrated.toFixed(4)}`,
);
close(goodBig.eceRaw, 0, 1e-12, 'an already-calibrated arm has eceRaw ~ 0');
ok(
  goodBig.eceRecalibrated < 0.05,
  'at n=1000 the recalibration floor is small (<0.05) for an already-calibrated arm',
);
ok(
  goodSmall.eceRecalibrated > goodSmall.eceRaw,
  'KNOWN BEHAVIOUR: at n=125 eceRecalibrated EXCEEDS eceRaw even for a perfectly calibrated arm — ' +
    'the recalibrated column is for comparing the two ARMS, never an arm against its own raw score',
);
ok(
  goodSmall.eceRecalibrated > goodBig.eceRecalibrated,
  'the recalibration estimation floor shrinks with n, as an estimation floor should',
);

// scoreCase stamps the score kind so the asymmetry is explicit in the JSON.
const baselineScored = scoreCase(
  goldenCase({ id: 'kind-1', expectedVerdict: 'BAD_CALL' }),
  councilResult({ verdict: 'BAD_CALL', accuracyScore: 0.55 }),
  [],
  'baseline',
);
const councilScored = scoreCase(
  goldenCase({ id: 'kind-2', expectedVerdict: 'BAD_CALL' }),
  councilResult({ verdict: 'BAD_CALL', accuracyScore: 0.85 }),
  [],
  'council',
);
eq(baselineScored.scoreKind, 'self_probability', 'scoreCase stamps the baseline as self_probability');
eq(councilScored.scoreKind, 'council_formula', 'scoreCase stamps the council as council_formula');

// ===========================================================================
// 15. SHOULD-FIX 7 — retrievalHitRate is run metadata, not an arm metric
// ===========================================================================

section('retrievalHitRate is arm-independent, so it is run metadata');

const retrievalPair = pairOutcomes(
  Array.from({ length: 10 }, (_, i) =>
    outcome({
      caseId: `ret-${i}`,
      arm: 'baseline',
      retrievalHit: i < 8,
      actualVerdict: 'BAD_CALL',
      expectedVerdict: 'BAD_CALL',
    }),
  ),
  Array.from({ length: 10 }, (_, i) =>
    outcome({
      caseId: `ret-${i}`,
      arm: 'council',
      retrievalHit: i < 8, // identical BY CONSTRUCTION: prepareCase() is the same
      actualVerdict: i < 3 ? 'BAD_CALL' : 'FAIR_CALL',
      expectedVerdict: 'BAD_CALL',
    }),
  ),
);
const retrieval = retrievalMetadata(retrievalPair);
close(retrieval.retrievalHitRate, 0.8, 1e-12, 'retrieval hit rate is computed once for the run');
eq(retrieval.retrievalHitDisagreements.length, 0, 'the two arms never disagree about retrievalHit');

const retrievalReport = compare(retrievalPair.baseline, retrievalPair.council, {
  goldenVersion: 'ret@1',
  sports: ['soccer'],
  generatedAt: '2026-01-01T00:00:00.000Z',
});
close(
  retrievalReport.runMetadata.retrievalHitRate,
  0.8,
  1e-12,
  'retrievalHitRate lives in runMetadata, not on either arm',
);
ok(
  !Object.prototype.hasOwnProperty.call(retrievalReport.delta, 'retrievalHitRate'),
  'there is NO retrievalHitRate delta — it would be 0 by construction and mean nothing',
);
ok(
  !Object.prototype.hasOwnProperty.call(retrievalReport.baseline, 'retrievalHitRate'),
  'retrievalHitRate is no longer a field on ArmMetrics at all',
);
// A do-nothing stub arm scores the same value — which is the whole point.
const stubArm = retrievalPair.council.map((o) => ({
  ...o,
  actualVerdict: 'INCONCLUSIVE' as Verdict,
  verdictCorrect: false,
}));
const stubReport = compare(retrievalPair.baseline, stubArm, {
  goldenVersion: 'ret@1',
  sports: ['soccer'],
  generatedAt: '2026-01-01T00:00:00.000Z',
});
close(
  stubReport.runMetadata.retrievalHitRate,
  retrievalReport.runMetadata.retrievalHitRate,
  1e-12,
  'a do-nothing stub arm scores the SAME retrieval hit rate — it measures retrieval, not the arm',
);

// A disagreement would mean prepareCase() is non-deterministic, and must shout.
const inconsistent = pairOutcomes(
  [outcome({ caseId: 'x-1', arm: 'baseline', retrievalHit: true })],
  [outcome({ caseId: 'x-1', arm: 'council', retrievalHit: false })],
);
eq(
  retrievalMetadata(inconsistent).retrievalHitDisagreements.length,
  1,
  'an arm-dependent retrievalHit is detected and named',
);

// ===========================================================================
// 16. The honesty guards still hold after the rewrite
// ===========================================================================

section('honesty guards survive the paired rewrite');

// A positive PAIRED delta that fails significance is still not a win.
eq(
  reportFor([
    ...repeat<[boolean, boolean]>([true, true], 8),
    ...repeat<[boolean, boolean]>([false, true], 4),
    ...repeat<[boolean, boolean]>([true, false], 2),
    ...repeat<[boolean, boolean]>([false, false], 6),
  ]).verdict,
  'NO_SIGNIFICANT_DIFFERENCE',
  'COUNCIL_BETTER still requires significance, not just a positive paired delta',
);

// Errors alone can never manufacture a COUNCIL_BETTER: dropping cases from one
// arm no longer moves the delta, and McNemar was always paired.
const errorsOnly = pairedOutcomes([
  ...repeat<[boolean, boolean]>([true, true], 40),
  ...repeat<[boolean, boolean]>([false, false], 40),
]);
for (let i = 0; i < 30; i += 1) errorsOnly.council[40 + i].error = 'HTTP 502';
const errorsOnlyReport = compare(errorsOnly.baseline, errorsOnly.council, {
  goldenVersion: 'err@1',
  sports: ['soccer'],
  generatedAt: '2026-01-01T00:00:00.000Z',
});
close(
  errorsOnlyReport.delta.verdictAccuracy,
  0,
  1e-12,
  'an arm that ONLY errors out of cases it would have failed gains exactly 0pp',
);
ok(
  errorsOnlyReport.pairing.unpairedAccuracyDelta > 0.25,
  'the same run would have reported a >25pp "improvement" on per-arm denominators',
);
eq(
  errorsOnlyReport.verdict,
  'NO_SIGNIFICANT_DIFFERENCE',
  'erroring out of hard cases can no longer produce a COUNCIL_BETTER banner',
);

// A significant regression still exits non-zero via COUNCIL_WORSE.
eq(
  reportFor([
    ...repeat<[boolean, boolean]>([true, false], 10),
    ...repeat<[boolean, boolean]>([true, true], 5),
    ...repeat<[boolean, boolean]>([false, false], 5),
  ]).verdict,
  'COUNCIL_WORSE',
  'the CLI regression gate (COUNCIL_WORSE) is unchanged',
);

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

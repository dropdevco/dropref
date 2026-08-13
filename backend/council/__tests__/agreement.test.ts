/**
 * Offline unit tests for backend/council/agreement.ts.
 *
 * Plain Node script — this repo has no test runner and is not getting one for
 * eight assertions. Run with:  npm run test:council
 * Exits non-zero on the first failing assertion tally.
 *
 * agreement.ts is pure by construction (no network, no env), so nothing here
 * touches an API.
 */

import {
  ACCURACY_WEIGHTS,
  accuracyScore,
  citationAgreement,
  computeAgreement,
  jaccard,
  normalizeProbability,
  reliabilityBand,
  type VerdictSample,
} from '../agreement';
import type { Verdict } from '../../../types/contract';

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function close(name: string, actual: number, expected: number, eps = 1e-3): void {
  check(
    name,
    Math.abs(actual - expected) <= eps,
    `expected ~${expected} (±${eps}), got ${actual}`,
  );
}

function seat(
  verdict: Verdict,
  selfProbability: number,
  citedRuleRefs: string[] = [],
): VerdictSample {
  return { verdict, selfProbability, citedRuleRefs };
}

const REF_A = 'Law 12.1 :: reckless-challenge-yellow-card';
const REF_B = 'Law 12.1 :: handball-deliberate';
const REF_C = 'Law 11.2 :: offside-position';

/* ---------------------------------------------------------------- */
console.log('\nunanimous panel');
{
  const m = computeAgreement([
    seat('BAD_CALL', 0.9, [REF_A]),
    seat('BAD_CALL', 0.85, [REF_A]),
    seat('BAD_CALL', 0.8, [REF_A]),
  ]);
  eq('consensusRatio === 1', m.consensusRatio, 1);
  eq('verdictEntropy === 0', m.verdictEntropy, 0);
  eq('modal verdict is BAD_CALL', m.distribution.BAD_CALL, 3);
  close('meanProbability', m.meanProbability, 0.85);
  eq('citationAgreement === 1', m.citationAgreement, 1);
}

/* ---------------------------------------------------------------- */
console.log('\nthree-way split');
{
  const m = computeAgreement([
    seat('FAIR_CALL', 0.6, [REF_A]),
    seat('BAD_CALL', 0.6, [REF_B]),
    seat('INCONCLUSIVE', 0.6, [REF_C]),
  ]);
  eq('verdictEntropy === 1', m.verdictEntropy, 1);
  close('consensusRatio = 1/3', m.consensusRatio, 1 / 3);
  eq('citationAgreement === 0 (disjoint)', m.citationAgreement, 0);
}

/* ---------------------------------------------------------------- */
console.log('\ntwo-one split');
{
  const m = computeAgreement([
    seat('FAIR_CALL', 0.7, [REF_A]),
    seat('FAIR_CALL', 0.7, [REF_A]),
    seat('BAD_CALL', 0.55, [REF_B]),
  ]);
  close('consensusRatio ~ 0.667', m.consensusRatio, 2 / 3);
  check(
    'verdictEntropy strictly between 0 and 1',
    m.verdictEntropy > 0 && m.verdictEntropy < 1,
    `got ${m.verdictEntropy}`,
  );
  close('meanProbability over modal holders only', m.meanProbability, 0.7);
}

/* ---------------------------------------------------------------- */
console.log('\naccuracyScore monotonicity');
{
  const confidentUnanimous = computeAgreement([
    seat('BAD_CALL', 0.92, [REF_A]),
    seat('BAD_CALL', 0.9, [REF_A]),
    seat('BAD_CALL', 0.88, [REF_A]),
  ]);
  const unconfidentSplit = computeAgreement([
    seat('FAIR_CALL', 0.4, [REF_A]),
    seat('BAD_CALL', 0.35, [REF_B]),
    seat('INCONCLUSIVE', 0.3, [REF_C]),
  ]);
  const hi = accuracyScore(confidentUnanimous);
  const lo = accuracyScore(unconfidentSplit);
  check('unanimous+confident > split+unconfident', hi > lo, `${hi} vs ${lo}`);
  eq('unanimous+confident is TRUSTWORTHY', reliabilityBand(hi), 'TRUSTWORTHY');
  eq('split+unconfident is UNRELIABLE', reliabilityBand(lo), 'UNRELIABLE');

  // Every input moved in the "more agreement / more confidence" direction must
  // be non-decreasing, one axis at a time.
  const base = {
    consensusRatio: 0.5,
    verdictEntropy: 0.5,
    citationAgreement: 0.5,
    meanProbability: 0.5,
    distribution: { FAIR_CALL: 1, BAD_CALL: 1, INCONCLUSIVE: 0 },
  };
  const b = accuracyScore(base);
  check('raising consensusRatio never lowers the score', accuracyScore({ ...base, consensusRatio: 0.9 }) >= b);
  check('raising meanProbability never lowers the score', accuracyScore({ ...base, meanProbability: 0.9 }) >= b);
  check('raising citationAgreement never lowers the score', accuracyScore({ ...base, citationAgreement: 0.9 }) >= b);
  check('lowering verdictEntropy never lowers the score', accuracyScore({ ...base, verdictEntropy: 0.1 }) >= b);
  check('raising verdictEntropy never raises the score', accuracyScore({ ...base, verdictEntropy: 0.9 }) <= b);

  eq(
    'perfect agreement scores exactly 1',
    accuracyScore({
      consensusRatio: 1,
      verdictEntropy: 0,
      citationAgreement: 1,
      meanProbability: 1,
      distribution: { FAIR_CALL: 0, BAD_CALL: 3, INCONCLUSIVE: 0 },
    }),
    1,
  );
  close(
    'weights sum to 1',
    ACCURACY_WEIGHTS.consensus +
      ACCURACY_WEIGHTS.probability +
      ACCURACY_WEIGHTS.entropy +
      ACCURACY_WEIGHTS.citation,
    1,
    1e-12,
  );
}

/* ---------------------------------------------------------------- */
console.log('\njaccard edge cases');
{
  eq('identical sets → 1', jaccard([REF_A, REF_B], [REF_B, REF_A]), 1);
  eq('disjoint sets → 0', jaccard([REF_A], [REF_B]), 0);
  eq('both empty → 1', jaccard([], []), 1);
  eq('one empty, one not → 0', jaccard([REF_A], []), 0);
  close('half overlap → 1/3', jaccard([REF_A, REF_B], [REF_B, REF_C]), 1 / 3);

  eq('citationAgreement of all-empty seats → 1', citationAgreement([[], [], []]), 1);
  eq('citationAgreement of a single seat → 1', citationAgreement([[REF_A]]), 1);
  eq('citationAgreement of identical seats → 1', citationAgreement([[REF_A], [REF_A]]), 1);
  eq('citationAgreement of disjoint seats → 0', citationAgreement([[REF_A], [REF_B]]), 0);
}

/* ---------------------------------------------------------------- */
console.log('\nprobability normalisation');
{
  eq('NaN falls back to the HIGH midpoint', normalizeProbability(NaN, 'HIGH'), 0.9);
  eq('undefined falls back to the LOW midpoint', normalizeProbability(undefined, 'LOW'), 0.25);
  eq('null falls back to the MEDIUM midpoint', normalizeProbability(null, 'MEDIUM'), 0.65);
  eq('above range clamps to 1', normalizeProbability(4.2, 'HIGH'), 1);
  eq('below range clamps to 0', normalizeProbability(-3, 'LOW'), 0);
  eq('in-range passes through', normalizeProbability(0.42, 'MEDIUM'), 0.42);

  const m = computeAgreement([seat('BAD_CALL', 5), seat('BAD_CALL', -1)]);
  close('out-of-range probabilities are clamped inside the metrics', m.meanProbability, 0.5);
}

/* ---------------------------------------------------------------- */
console.log('\nempty and degenerate input');
{
  const m = computeAgreement([]);
  eq('no seats → consensusRatio 0', m.consensusRatio, 0);
  eq('no seats → maximal entropy', m.verdictEntropy, 1);
  eq('no seats → UNRELIABLE', reliabilityBand(accuracyScore(m)), 'UNRELIABLE');
}

/* ---------------------------------------------------------------- */
console.log('\ncoverage-aware consensus (a dead seat is not a silent one)');
{
  const three = [seat('FAIR_CALL', 0.8), seat('FAIR_CALL', 0.8), seat('FAIR_CALL', 0.8)];
  const two = [seat('FAIR_CALL', 0.8), seat('FAIR_CALL', 0.8)];
  const full = computeAgreement(three, undefined, 3);
  const degraded = computeAgreement(two, undefined, 3);

  eq('a full panel divides by the seats it has', full.consensusDenominator, 3);
  eq('a degraded panel still divides by the panel we ASKED', degraded.consensusDenominator, 3);
  close('3 of 3 agreeing is unanimous', full.consensusRatio, 1);
  close('2 of 3 agreeing is NOT unanimous', degraded.consensusRatio, 2 / 3);
  check(
    'a degraded panel scores STRICTLY below a full one',
    accuracyScore(degraded) < accuracyScore(full),
    accuracyScore(degraded) + ' vs ' + accuracyScore(full),
  );
  check(
    'a degraded panel does not clear a 0.75 consensus gate',
    degraded.consensusRatio < 0.75,
    String(degraded.consensusRatio),
  );
  close('no expected size given, divide by what answered', computeAgreement(two).consensusRatio, 1);
}

/* ---------------------------------------------------------------- */
console.log('\nthe chair does not vote in the tally that grades it');
{
  const panel = [seat('FAIR_CALL', 0.7), seat('FAIR_CALL', 0.7), seat('BAD_CALL', 0.7)];
  const chairVote = seat('BAD_CALL', 0.85);
  const excluded = computeAgreement(panel, 'BAD_CALL', 3);
  const included = computeAgreement([...panel, chairVote], 'BAD_CALL', 3);

  close('only the seats are counted', excluded.consensusRatio, 1 / 3);
  close('the chair is not one of the seats', excluded.meanProbability, 0.7);
  check(
    'letting the chair vote would inflate its own score',
    accuracyScore(included) > accuracyScore(excluded),
    accuracyScore(included) + ' vs ' + accuracyScore(excluded),
  );
  eq('agreementFocus is the verdict being graded', excluded.agreementFocus, 'BAD_CALL');
  eq('the raw tally stays honest', excluded.distribution.FAIR_CALL, 2);
}

/* ---------------------------------------------------------------- */
console.log('\nweight ordering (the design claim, not just the arithmetic)');
{
  check(
    'consensus outweighs self-reported probability',
    ACCURACY_WEIGHTS.consensus > ACCURACY_WEIGHTS.probability,
    ACCURACY_WEIGHTS.consensus + ' vs ' + ACCURACY_WEIGHTS.probability,
  );
  check(
    'probability outweighs inverse entropy',
    ACCURACY_WEIGHTS.probability > ACCURACY_WEIGHTS.entropy,
    ACCURACY_WEIGHTS.probability + ' vs ' + ACCURACY_WEIGHTS.entropy,
  );
  check(
    'inverse entropy outweighs citation agreement',
    ACCURACY_WEIGHTS.entropy > ACCURACY_WEIGHTS.citation,
    ACCURACY_WEIGHTS.entropy + ' vs ' + ACCURACY_WEIGHTS.citation,
  );
}

/* ---------------------------------------------------------------- */
console.log(
  `\n${passed} passed, ${failures.length} failed (${passed + failures.length} assertions)`,
);
if (failures.length > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('council agreement tests OK\n');

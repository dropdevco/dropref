/**
 * Offline mechanism tests for backend/graph/{observe,audit,score,run}.ts.
 *
 * Plain Node script, same style as backend/council/__tests__/council.test.ts.
 * Run with: npm run test:graph
 *
 * NO NETWORK. `installStubTransport` replaces `globalThis.fetch` with a
 * scripted fake, so nothing here can reach OpenRouter even if a real key is
 * present in the environment.
 *
 * What these tests are for. The graph's value is three claims, and none of them
 * is visible in the return value of a happy-path run:
 *   1. two observers who disagree produce CONTESTED facts, and those facts
 *      reach the seats
 *   2. the auditor can lower a verdict's reliability WITHOUT changing it
 *   3. every degraded path (dead observer, dead reconciler, dead auditor)
 *      still returns an answer, and never one labelled TRUSTWORTHY
 *
 * Deliberately NOT asserted: the literal values of MIN_FACTOR, the penalty
 * constants or the contested-fact step. Those are expected to be re-tuned, so
 * the tests assert RELATIONSHIPS that survive re-tuning (a penalty never
 * raises a score; an unmeasured signal costs nothing; a floor is a floor).
 */

import type { SportRule, Verdict } from '../../../types/contract';
import {
  captureWarnings,
  installStubTransport,
  trackTimers,
  type StubScript,
  type StubTransport,
} from '../../council/__tests__/stub-transport';
import type { CouncilInput } from '../../council/types';
import { contestedCeiling, observe } from '../observe';
import { coerceBoolean } from '../audit';
import {
  MIN_FACTOR,
  auditFactor,
  composeReliability,
  observationFactor,
} from '../score';
import { defaultGraphConfig } from '../models';
import { graphArm, mergeShortlists } from '../run';
import type { AuditResult, GraphInput, ObservationBundle } from '../types';

/* ------------------------------------------------------------------ */
/* Environment: dummy key, no inherited overrides, unusable fallback    */
/* ------------------------------------------------------------------ */

for (const key of Object.keys(process.env)) {
  if (key.startsWith('COUNCIL_') || key.startsWith('GRAPH_')) delete process.env[key];
}
process.env.OPENROUTER_API_KEY = 'stub-key-never-sent-anywhere';
// Any hop onto the fallback ladder shows up as an unscripted call instead of
// silently consuming another node's script.
process.env.COUNCIL_FALLBACK_MODEL = 'stub/fallback-must-not-be-used';
// Artifacts are a side effect; a unit test must not litter backend/runs.
process.env.GRAPH_ARTIFACTS = 'off';

// Every node gets a DISTINCT slug so the stub can key replies per node. The
// stub classifies by prompt content, and observers, reconciler and auditor all
// look like 'panel' calls to it — distinct slugs are what keep them apart.
process.env.GRAPH_OBSERVER_A_MODEL = 'stub/observer-a';
process.env.GRAPH_OBSERVER_B_MODEL = 'stub/observer-b';
process.env.GRAPH_RECONCILER_MODEL = 'stub/reconciler';
process.env.GRAPH_AUDITOR_MODEL = 'stub/auditor';
process.env.COUNCIL_SEAT_1_MODEL = 'stub/seat-1';
process.env.COUNCIL_SEAT_2_MODEL = 'stub/seat-2';
process.env.COUNCIL_SEAT_3_MODEL = 'stub/seat-3';
process.env.COUNCIL_CHAIR_MODEL = 'stub/chair';

/* ------------------------------------------------------------------ */
/* Reporting harness (mirrors council.test.ts)                         */
/* ------------------------------------------------------------------ */

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

function close(name: string, actual: number, expected: number, eps = 1e-9): void {
  check(name, Math.abs(actual - expected) <= eps, `expected ~${expected}, got ${actual}`);
}

const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String(reason));
});

const timers = trackTimers();

async function scenario(name: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n${name}`);
  timers.reset();
  const warnings = captureWarnings();
  try {
    await body();
  } catch (err) {
    check(`${name}: completed without an unexpected throw`, false, String(err));
  } finally {
    warnings.restore();
  }
  check(
    `${name}: cleared its deadline timer`,
    timers.live() === 0,
    `${timers.live()} timer(s) still live`,
  );
}

function record(name: string, t: StubTransport): void {
  check(
    `${name}: every request had a scripted reply`,
    t.unscripted.length === 0,
    t.unscripted.join('; '),
  );
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const RULES: SportRule[] = [
  {
    code: 'Law 12.1',
    title: 'Reckless challenge (yellow card)',
    text: 'A challenge made with disregard for the danger to an opponent is reckless and must be cautioned.',
    keywords: ['challenge', 'reckless'],
    callTypes: ['foul'],
    source: { url: 'https://example.invalid/law-12', publisher: 'IFAB', label: 'Law 12' },
  },
  {
    code: 'Law 11.2',
    title: 'Offside position',
    text: 'A player is in an offside position if any part of the head, body or feet is nearer to the opponents goal line than both the ball and the second-last opponent.',
    keywords: ['offside'],
    callTypes: ['offside'],
    source: { url: 'https://example.invalid/law-11', publisher: 'IFAB', label: 'Law 11' },
  },
];

const CORPUS = {
  id: 'soccer' as const,
  displayName: 'Soccer',
  governingBody: 'IFAB',
  officialTitle: 'Laws of the Game',
  analystPersona: 'analyst',
  observationHints: 'contact, ball position',
  commonCalls: ['foul'],
  rules: RULES,
};

function graphInput(overrides: Partial<GraphInput> = {}): GraphInput {
  return {
    sport: 'soccer',
    videoBase64: 'RkFLRQ==',
    videoMimeType: 'video/mp4',
    annotatedVideoBase64: 'QU5OT1RBVEVE',
    skeletonBase64: null,
    originalCall: 'foul on the attacker',
    cvMetadata: { telemetry: [] },
    keyFramesBase64: null,
    ...overrides,
  };
}

function councilInput(overrides: Partial<CouncilInput> = {}): CouncilInput {
  return {
    sport: 'soccer',
    displayName: 'Soccer',
    observation: 'The defender slid in and made contact with the attacker before touching the ball.',
    originalCall: 'foul on the attacker',
    candidates: RULES,
    ...overrides,
  };
}

function audit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    supportedClaims: [],
    unsupportedClaims: [],
    ruleMisuse: [],
    overreach: false,
    notes: '',
    model: 'stub/auditor',
    failed: false,
    latencyMs: 1,
    calls: 1,
    ...overrides,
  };
}

function bundle(overrides: Partial<ObservationBundle> = {}): ObservationBundle {
  return {
    observation: 'something happened',
    contested: [],
    observationAgreement: null,
    observers: [],
    reconciled: false,
    failedNodes: [],
    totalCalls: 0,
    processingMs: 0,
    ...overrides,
  };
}

/** A seat reply that settles the panel unanimously. */
function seatReply(verdict: Verdict = 'BAD_CALL') {
  return {
    json: {
      verdict,
      confidence: 'HIGH',
      selfProbability: 0.9,
      reasoning: 'The contact preceded the touch on the ball.',
      citedRuleRefs: ['Law 12.1 — Reckless challenge (yellow card)'],
    },
  };
}

const UNANIMOUS_PANEL: StubScript = {
  'stub/seat-1': { panel: seatReply() },
  'stub/seat-2': { panel: seatReply() },
  'stub/seat-3': { panel: seatReply() },
};

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* =============================================================== */
  section('1. observationFactor: an UNMEASURED signal costs nothing');
  /* =============================================================== */

  eq('null agreement (one observer, or a dead reconciler) is not a penalty', observationFactor(null), 1);
  eq('total agreement is not a penalty either', observationFactor(1), 1);
  close('total disagreement bottoms out at the floor', observationFactor(0), MIN_FACTOR);
  check(
    'the factor is monotone in agreement',
    observationFactor(0) <= observationFactor(0.5) &&
      observationFactor(0.5) <= observationFactor(1),
  );
  check(
    'a measured PERFECT agreement is never worse than an unmeasured one',
    observationFactor(1) >= observationFactor(null) - 1e-12,
  );
  check(
    'a measured POOR agreement IS worse than an unmeasured one',
    observationFactor(0.2) < observationFactor(null),
  );

  /* =============================================================== */
  section('2. contestedCeiling: the reconciler cannot talk its own findings away');
  /* =============================================================== */

  eq('no contested facts imposes no ceiling', contestedCeiling(0), 1);
  check('each contested fact lowers the ceiling', contestedCeiling(1) < contestedCeiling(0));
  check('the ceiling is monotone', contestedCeiling(3) < contestedCeiling(2));
  check('the ceiling never goes negative', contestedCeiling(50) >= 0);

  /* =============================================================== */
  section('3. auditFactor: findings become the penalty, in code');
  /* =============================================================== */

  eq('a clean audit that enumerated nothing is not a penalty', auditFactor(audit()), 1);
  eq(
    'a failed auditor is not a penalty either — it produced no findings to apply',
    auditFactor(audit({ failed: true })),
    1,
  );
  eq(
    'an audit where every claim is supported is not a penalty',
    auditFactor(audit({ supportedClaims: ['a', 'b', 'c'] })),
    1,
  );
  close(
    'an audit where NO claim is supported bottoms out at the floor',
    auditFactor(audit({ unsupportedClaims: ['a', 'b'] })),
    MIN_FACTOR,
  );
  check(
    'more unsupported claims never raise the factor',
    auditFactor(audit({ supportedClaims: ['a'], unsupportedClaims: ['x', 'y'] })) <=
      auditFactor(audit({ supportedClaims: ['a'], unsupportedClaims: ['x'] })),
  );
  check(
    'rule misuse is its own penalty on an otherwise clean audit',
    auditFactor(audit({ supportedClaims: ['a'], ruleMisuse: ['Law 11.2 does not govern'] })) < 1,
  );
  check(
    'overreach is its own penalty on an otherwise clean audit',
    auditFactor(audit({ supportedClaims: ['a'], overreach: true })) < 1,
  );
  check(
    'the floor holds even when every penalty fires at once',
    auditFactor(
      audit({ unsupportedClaims: ['a', 'b'], ruleMisuse: ['x'], overreach: true }),
    ) >= MIN_FACTOR,
  );
  eq('a boolean-ish "yes" is read as overreach', coerceBoolean('yes'), true);
  eq('a boolean-ish "false" is not', coerceBoolean('false'), false);

  /* =============================================================== */
  section('4. composeReliability: the council score survives untouched when nothing is wrong');
  /* =============================================================== */

  const clean = composeReliability(0.94, bundle(), audit({ supportedClaims: ['a'] }));
  close('a clean run scores EXACTLY what the council alone scored', clean.reliabilityScore, 0.94);
  eq('a clean, high-scoring run is TRUSTWORTHY', clean.reliability, 'TRUSTWORTHY');
  eq('a clean, high-scoring run is not held', clean.needsHumanReview, false);
  eq('a clean run has nothing to explain', clean.gateReasons.length, 0);

  const penalised = composeReliability(
    0.94,
    bundle({ observationAgreement: 0.3 }),
    audit({ supportedClaims: ['a'], unsupportedClaims: ['b', 'c'] }),
  );
  check('penalties only ever lower the score', penalised.reliabilityScore < clean.reliabilityScore);
  eq('the pre-penalty council score is still reported alongside', penalised.accuracyScore, 0.94);
  check(
    'a heavily penalised answer stops being TRUSTWORTHY',
    penalised.reliability !== 'TRUSTWORTHY',
  );

  /* =============================================================== */
  section('5. the human gate holds every unchecked answer');
  /* =============================================================== */

  const uncheckedAudit = composeReliability(0.99, bundle(), audit({ failed: true }));
  eq('a dead auditor never ships as TRUSTWORTHY', uncheckedAudit.needsHumanReview, true);
  check(
    'and it says why',
    uncheckedAudit.gateReasons.some((r) => r.includes('auditor')),
    uncheckedAudit.gateReasons.join(' | '),
  );
  close(
    'but a dead auditor does NOT invent a penalty out of its own absence',
    uncheckedAudit.reliabilityScore,
    0.99,
  );

  const uncheckedPremise = composeReliability(
    0.99,
    bundle({ failedNodes: ['reconciler'] }),
    audit({ supportedClaims: ['a'] }),
  );
  eq('an unreconciled premise is held too', uncheckedPremise.needsHumanReview, true);

  const overreached = composeReliability(
    0.99,
    bundle(),
    audit({ supportedClaims: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], overreach: true }),
  );
  eq(
    'an overreach finding holds the answer even when the arithmetic stays above the line',
    overreached.needsHumanReview,
    true,
  );

  const low = composeReliability(0.3, bundle(), audit({ supportedClaims: ['a'] }));
  eq('an ordinary low-reliability answer is held', low.needsHumanReview, true);

  /* =============================================================== */
  section('6. mergeShortlists: observation-led, coarse as the safety net');
  /* =============================================================== */

  const merged = mergeShortlists([RULES[1]], [RULES[0], RULES[1]], 5);
  eq('the merged shortlist deduplicates by ref', merged.length, 2);
  eq('the observation-driven rule leads', merged[0].title, RULES[1].title);
  eq('the coarse pass contributes what the primary missed', merged[1].title, RULES[0].title);
  eq('the cap is respected', mergeShortlists([RULES[0]], [RULES[1]], 1).length, 1);

  /* =============================================================== */
  section('7. observe(): two observers who disagree produce contested facts');
  /* =============================================================== */

  await scenario('disagreeing observers', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { text: 'The defender made contact before playing the ball.' } },
      'stub/observer-b': { panel: { text: 'The defender clearly won the ball first.' } },
      'stub/reconciler': {
        panel: {
          json: {
            agreed: 'A defender slid in near the attacker and there was contact.',
            contested: ['whether the defender touched the ball before the contact'],
            agreementScore: 0.95,
          },
        },
      },
    });
    try {
      const result = await observe(
        graphInput(),
        CORPUS,
        defaultGraphConfig(),
        new AbortController().signal,
      );
      eq('both observers ran', result.observers.length, 2);
      eq('the reconciler ran', result.reconciled, true);
      eq('the disagreement is surfaced as a contested fact', result.contested.length, 1);
      eq('the reconciled account is what goes downstream', result.observation.startsWith('A defender'), true);
      check(
        'the reconciler cannot claim 0.95 agreement while listing a disagreement',
        (result.observationAgreement ?? 1) <= contestedCeiling(1) + 1e-12,
        `got ${result.observationAgreement}`,
      );
      eq('nothing failed', result.failedNodes.length, 0);
      record('disagreeing observers', t);
    } finally {
      t.restore();
    }
  });

  await scenario('observers who agree', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { text: 'Contact before the ball.' } },
      'stub/observer-b': { panel: { text: 'The contact came before the touch.' } },
      'stub/reconciler': {
        panel: { json: { agreed: 'Contact preceded the touch.', contested: [], agreementScore: 0.9 } },
      },
    });
    try {
      const result = await observe(
        graphInput(),
        CORPUS,
        defaultGraphConfig(),
        new AbortController().signal,
      );
      eq('no contested facts', result.contested.length, 0);
      close('the reconciler score stands when nothing is contested', result.observationAgreement ?? -1, 0.9);
      check(
        'agreeing observers are not penalised',
        observationFactor(result.observationAgreement) > observationFactor(0.5),
      );
      record('observers who agree', t);
    } finally {
      t.restore();
    }
  });

  /* =============================================================== */
  section('8. observe(): every degraded path still returns an observation');
  /* =============================================================== */

  await scenario('no CV evidence: one observer, no reconciler', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { text: 'A tackle from behind.' } },
    });
    try {
      const result = await observe(
        graphInput({ annotatedVideoBase64: null, skeletonBase64: null, keyFramesBase64: null }),
        CORPUS,
        defaultGraphConfig(),
        new AbortController().signal,
      );
      eq('observer B is not run without CV evidence to give it', result.observers.length, 1);
      eq('the reconciler is not run either', result.reconciled, false);
      eq('agreement is UNMEASURED, not zero', result.observationAgreement, null);
      eq('one observer is not a failure', result.failedNodes.length, 0);
      eq('exactly one call was spent', result.totalCalls, 1);
      record('no CV evidence: one observer, no reconciler', t);
    } finally {
      t.restore();
    }
  });

  await scenario('a dead observer costs one observer, not the request', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { text: 'A tackle from behind.' } },
      'stub/observer-b': { panel: { networkError: 'socket hang up' } },
    });
    try {
      const result = await observe(
        graphInput(),
        CORPUS,
        defaultGraphConfig(),
        new AbortController().signal,
      );
      eq('the survivor supplies the observation', result.observation, 'A tackle from behind.');
      eq('the dead observer is named', result.failedNodes[0], 'observer-b');
      eq('agreement is unmeasured, not zero', result.observationAgreement, null);
      record('a dead observer costs one observer, not the request', t);
    } finally {
      t.restore();
    }
  });

  await scenario('a dead reconciler falls back and FLAGS itself', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { text: 'Contact before the ball.' } },
      'stub/observer-b': { panel: { text: 'The defender won the ball.' } },
      'stub/reconciler': { panel: { httpStatus: 500, body: 'upstream exploded' } },
      // A 5xx is a MODEL-specific failure, so councilChat correctly tries the
      // shared fallback slug next. The reconciler only counts as dead once that
      // hop has failed too — scripting it here asserts the ladder is real
      // rather than pretending the reconciler gets one shot.
      'stub/fallback-must-not-be-used': {
        panel: { httpStatus: 500, body: 'fallback exploded too' },
      },
    });
    try {
      const result = await observe(
        graphInput(),
        CORPUS,
        defaultGraphConfig(),
        new AbortController().signal,
      );
      eq('observer A supplies the fallback account', result.observation, 'Contact before the ball.');
      eq('the failure is recorded', result.failedNodes.includes('reconciler'), true);
      eq('the premise is marked unreconciled', result.reconciled, false);
      const score = composeReliability(0.99, result, audit({ supportedClaims: ['a'] }));
      eq('and the gate holds the run because of it', score.needsHumanReview, true);
      record('a dead reconciler falls back and FLAGS itself', t);
    } finally {
      t.restore();
    }
  });

  await scenario('both observers dead: there is nothing to adjudicate', async () => {
    const t = installStubTransport({
      'stub/observer-a': { panel: { networkError: 'down' } },
      'stub/observer-b': { panel: { networkError: 'down' } },
    });
    let threw = false;
    try {
      await observe(graphInput(), CORPUS, defaultGraphConfig(), new AbortController().signal);
    } catch {
      threw = true;
    } finally {
      t.restore();
    }
    eq('the observation stage throws rather than inventing a play', threw, true);
  });

  /* =============================================================== */
  section('9. graphArm: the auditor lowers reliability WITHOUT changing the verdict');
  /* =============================================================== */

  await scenario('a clean audit leaves the council answer alone', async () => {
    const t = installStubTransport({
      ...UNANIMOUS_PANEL,
      'stub/auditor': {
        panel: {
          json: {
            supportedClaims: ['contact preceded the touch'],
            unsupportedClaims: [],
            ruleMisuse: [],
            overreach: false,
            notes: 'nothing to flag',
          },
        },
      },
    });
    try {
      const result = await graphArm(councilInput());
      eq('the verdict is the council', result.verdict, 'BAD_CALL');
      eq('a unanimous, clean run stays TRUSTWORTHY', result.reliability, 'TRUSTWORTHY');
      check('the audit call is counted', result.totalCalls >= 4, `got ${result.totalCalls}`);
      record('a clean audit leaves the council answer alone', t);
    } finally {
      t.restore();
    }
  });

  await scenario('a damning audit lowers the score but not the verdict', async () => {
    const t = installStubTransport({
      ...UNANIMOUS_PANEL,
      'stub/auditor': {
        panel: {
          json: {
            supportedClaims: [],
            unsupportedClaims: [
              'that the contact preceded the touch',
              'that the challenge was reckless',
            ],
            ruleMisuse: ['Law 11.2 does not govern a tackle'],
            overreach: true,
            notes: 'the observation never establishes the order of events',
          },
        },
      },
    });
    try {
      const result = await graphArm(councilInput());
      eq('the auditor does NOT get to change the verdict', result.verdict, 'BAD_CALL');
      check(
        'a unanimous council with a damning audit is no longer TRUSTWORTHY',
        result.reliability !== 'TRUSTWORTHY',
        `got ${result.reliability} at ${result.accuracyScore}`,
      );
      record('a damning audit lowers the score but not the verdict', t);
    } finally {
      t.restore();
    }
  });

  await scenario('a dead auditor still returns an answer', async () => {
    const t = installStubTransport({
      ...UNANIMOUS_PANEL,
      'stub/auditor': { panel: { networkError: 'auditor unreachable' } },
    });
    try {
      const result = await graphArm(councilInput());
      eq('the answer survives', result.verdict, 'BAD_CALL');
      record('a dead auditor still returns an answer', t);
    } finally {
      t.restore();
    }
  });

  /* =============================================================== */
  section('10. contested facts actually reach the seats');
  /* =============================================================== */

  await scenario('the seats are told what the observers could not settle', async () => {
    const t = installStubTransport({
      ...UNANIMOUS_PANEL,
      'stub/auditor': {
        panel: {
          json: {
            supportedClaims: ['a'],
            unsupportedClaims: [],
            ruleMisuse: [],
            overreach: false,
            notes: '',
          },
        },
      },
    });
    try {
      await graphArm(
        councilInput({ contested: ['whether the defender touched the ball first'] }),
      );
      const seatPrompts = t.calls
        .filter((c) => c.model.startsWith('stub/seat-'))
        .map((c) => c.prompt);
      check('all three seats were prompted', seatPrompts.length === 3, `got ${seatPrompts.length}`);
      check(
        'every seat was shown the contested fact',
        seatPrompts.every((p) => p.includes('whether the defender touched the ball first')),
      );
      check(
        'and told to treat it as unsettled',
        seatPrompts.every((p) => p.includes('UNSETTLED')),
      );
      record('the seats are told what the observers could not settle', t);
    } finally {
      t.restore();
    }
  });

  await scenario('with nothing contested, the seat prompt is unchanged', async () => {
    const t = installStubTransport({
      ...UNANIMOUS_PANEL,
      'stub/auditor': {
        panel: {
          json: {
            supportedClaims: ['a'],
            unsupportedClaims: [],
            ruleMisuse: [],
            overreach: false,
            notes: '',
          },
        },
      },
    });
    try {
      await graphArm(councilInput({ contested: [] }));
      const seatPrompts = t.calls
        .filter((c) => c.model.startsWith('stub/seat-'))
        .map((c) => c.prompt);
      check(
        'no contested block is injected when there is nothing to contest',
        seatPrompts.every((p) => !p.includes('COULD NOT AGREE ON')),
      );
      record('with nothing contested, the seat prompt is unchanged', t);
    } finally {
      t.restore();
    }
  });

  // Let any stray rejection surface before the summary.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  eq('no unhandled promise rejections', unhandled.length, 0);
  timers.restore();
}

main()
  .then(() => {
    console.log(
      `\n${passed} passed, ${failures.length} failed (${passed + failures.length} assertions)`,
    );
    if (failures.length > 0) {
      console.error('\nFailures:');
      for (const f of failures) console.error(`  - ${f}`);
      process.exit(1);
    }
    console.log('graph mechanism tests OK\n');
  })
  .catch((err) => {
    console.error('\nTest harness crashed:', err);
    process.exit(1);
  });

/**
 * Offline mechanism tests for backend/council/{index,panel,debate,chair,prompts,client}.ts.
 *
 * Plain Node script, same style as agreement.test.ts. Run with:
 *   npm run test:council
 *
 * NO NETWORK. `installStubTransport` replaces `globalThis.fetch` with a
 * scripted fake that records every request, so nothing here can reach
 * OpenRouter even if a key happens to be present in the environment.
 *
 * What these tests are for: the council's VALUE is entirely in its mechanism -
 * anonymised debate, ref-disciplined citation, escalation only when the seats
 * genuinely disagree, quorum, honest call accounting. Every one of those is
 * invisible in the return value of a happy-path run, so each is asserted
 * against the captured prompts or against a scripted disagreement.
 *
 * Deliberately NOT asserted: the literal values of consensusThreshold,
 * minProbability, quorum or TRUSTWORTHY_MIN. Those cut-points are expected to
 * be re-tuned. Where a threshold has to be exercised, the test either passes
 * its own value in via CouncilConfig and asserts the BEHAVIOUR that value
 * produces, or asserts a relationship (dissent scores below unanimity; a live
 * dissent is never TRUSTWORTHY) that survives re-tuning.
 */

import {
  accuracyScore,
  computeAgreement,
  reliabilityBand,
  REVIEW_SUGGESTED_MIN,
  TRUSTWORTHY_MIN,
  type VerdictSample,
} from '../agreement';
import { CouncilCallError, councilChatJson } from '../client';
import { CouncilQuorumError, runCouncil, runSingleModel } from '../index';
import { defaultCouncilConfig } from '../models';
import { PanelResponseSchema, runPanel } from '../panel';
import {
  buildPanelPrompt,
  citeRulesByRef,
  filterValidRuleRefs,
  refList,
  renderCandidates,
} from '../prompts';
import { ruleRef } from '../rule-ref';
import type {
  CouncilConfig,
  CouncilInput,
  CouncilResult,
  CouncilSeat,
} from '../types';
import type { Confidence, SportRule, Verdict } from '../../../types/contract';
import {
  captureWarnings,
  installStubTransport,
  trackTimers,
  type StubReply,
  type StubScript,
  type StubTransport,
} from './stub-transport';

/* ------------------------------------------------------------------ */
/* Environment: dummy key, no council env overrides, unusable fallback  */
/* ------------------------------------------------------------------ */

for (const key of Object.keys(process.env)) {
  if (key.startsWith('COUNCIL_')) delete process.env[key];
}
process.env.OPENROUTER_API_KEY = 'stub-key-never-sent-anywhere';
// Any hop onto the fallback ladder must show up as an unscripted call rather
// than silently consuming another seat's script.
process.env.COUNCIL_FALLBACK_MODEL = 'stub/fallback-must-not-be-used';

/* ------------------------------------------------------------------ */
/* Reporting harness (mirrors agreement.test.ts)                       */
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
  check(
    name,
    Object.is(actual, expected),
    `expected ${String(expected)}, got ${String(actual)}`,
  );
}

function close(name: string, actual: number, expected: number, eps = 1e-9): void {
  check(
    name,
    Math.abs(actual - expected) <= eps,
    `expected ~${expected} (±${eps}), got ${actual}`,
  );
}

function eqList(name: string, actual: string[], expected: string[]): void {
  check(
    name,
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const unhandled: string[] = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String(reason));
});

const timers = trackTimers();
/** Every prompt any seat was shown, across every scenario. */
const allPrompts: { scenario: string; stage: string; prompt: string }[] = [];

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
  check(`${name}: cleared its deadline timer`, timers.live() === 0, `${timers.live()} timer(s) still live`);
}

function record(name: string, t: StubTransport): void {
  for (const call of t.calls) {
    allPrompts.push({ scenario: name, stage: call.stage, prompt: call.prompt });
  }
  check(`${name}: every request had a scripted reply`, t.unscripted.length === 0, t.unscripted.join('; '));
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/**
 * Two of these share the code "Law 12.1" on purpose - that is the real soccer
 * corpus shape and the whole reason prompts must present rules by ruleRef().
 */
const RULES: SportRule[] = [
  {
    code: 'Law 12.1',
    title: 'Reckless challenge (yellow card)',
    text: 'A challenge made with disregard for the danger to an opponent is reckless and must be cautioned.',
    keywords: ['challenge', 'reckless'],
    callTypes: ['foul'],
    source: { url: 'https://example.invalid/law-12', publisher: 'IFAB', label: 'Laws of the Game, Law 12' },
  },
  {
    code: 'Law 12.1',
    title: 'Deliberate handball',
    text: 'A player who deliberately handles the ball commits an offence unless they are the goalkeeper inside their own penalty area.',
    keywords: ['handball'],
    callTypes: ['handball'],
    source: { url: 'https://example.invalid/law-12', publisher: 'IFAB', label: 'Laws of the Game, Law 12' },
  },
  {
    code: 'Law 11.2',
    title: 'Offside position',
    text: 'A player is in an offside position if any part of the head, body or feet is nearer to the opponents goal line than both the ball and the second-last opponent.',
    keywords: ['offside'],
    callTypes: ['offside'],
    source: { url: 'https://example.invalid/law-11', publisher: 'IFAB', label: 'Laws of the Game, Law 11' },
  },
];

const REF_RECKLESS = ruleRef(RULES[0]);
const REF_HANDBALL = ruleRef(RULES[1]);
const REF_OFFSIDE = ruleRef(RULES[2]);

const INPUT: CouncilInput = {
  sport: 'soccer',
  displayName: 'Soccer',
  observation:
    'The defender slides in from the side and contacts the attacker on the shin after the ball has already been played away.',
  originalCall: 'Referee awarded a free kick and showed a yellow card.',
  candidates: RULES,
};

/** Distinctive, brand-free strings so a prompt can be searched for one seat. */
const MARK = {
  seat1: 'MARKER-ALPHA-ONE',
  seat2: 'MARKER-BRAVO-TWO',
  seat3: 'MARKER-CHARLIE-THREE',
} as const;

const MODEL = {
  seat1: 'google/gemini-2.5-flash',
  seat2: 'openai/gpt-4o-mini',
  seat3: 'anthropic/claude-haiku-4.5',
  chair: 'anthropic/claude-opus-4.5',
} as const;

const SEATS: CouncilSeat[] = [
  { id: 'seat-1', model: MODEL.seat1, role: 'literalist', temperature: 0.1 },
  { id: 'seat-2', model: MODEL.seat2, role: 'prosecutor', temperature: 0.4 },
  { id: 'seat-3', model: MODEL.seat3, role: 'defender', temperature: 0.4 },
];

const CHAIR: CouncilSeat = {
  id: 'chair',
  model: MODEL.chair,
  role: 'chair',
  temperature: 0.1,
};

/**
 * Thresholds are supplied EXPLICITLY here. Tests that mean to exercise the
 * shipped defaults call `shippedConfig()` instead, so re-tuning a default is
 * visible in exactly the tests that are about the defaults.
 */
function testConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return {
    seats: SEATS.map((s) => ({ ...s })),
    chair: { ...CHAIR },
    consensusThreshold: 0.75,
    minProbability: 0.65,
    quorum: 2,
    timeoutMs: 5_000,
    enabled: true,
    ...overrides,
  };
}

/** The real shipped defaults, with only the wall-clock shortened. */
function shippedConfig(overrides: Partial<CouncilConfig> = {}): CouncilConfig {
  return defaultCouncilConfig({ timeoutMs: 5_000, ...overrides });
}

/* -------- scripted reply builders -------- */

const GARBAGE: StubReply = { text: 'I am afraid I cannot answer that.' };
const OUTAGE: StubReply = { httpStatus: 401, body: 'stubbed seat outage' };

function panelReply(
  verdict: Verdict,
  confidence: Confidence,
  selfProbability: number | undefined,
  reasoning: string,
  citedRuleRefs: string[],
): StubReply {
  return {
    json: { verdict, confidence, selfProbability, reasoning, citedRuleRefs },
  };
}

function debateReply(
  revisedVerdict: Verdict,
  revisedConfidence: Confidence,
  revisedProbability: number | undefined,
  critique: string,
  citedRuleRefs: string[],
): StubReply {
  return {
    json: {
      revisedVerdict,
      revisedConfidence,
      revisedProbability,
      critique,
      citedRuleRefs,
      changedMind: false,
    },
  };
}

function chairReply(
  verdict: Verdict,
  confidence: Confidence,
  selfProbability: number,
  citedRuleRefs: string[],
): StubReply {
  return {
    json: {
      verdict,
      confidence,
      selfProbability,
      reasoning: 'The chair rules on the governing rule text.',
      rationale: 'The lens that read the rule element by element was decisive.',
      citedRuleRefs,
    },
  };
}

function sample(
  verdict: Verdict,
  selfProbability: number,
  citedRuleRefs: string[],
): VerdictSample {
  return { verdict, selfProbability, citedRuleRefs };
}

/* -------- prompt dissection -------- */

/** The "THE OTHER SEATS" section only - a seat's own opinion is shown above it. */
function othersBlock(user: string): string {
  const start = user.indexOf('THE OTHER SEATS:');
  const end = user.indexOf('Return ONLY this JSON object:');
  if (start < 0 || end < 0 || end < start) return '';
  return user.slice(start, end);
}

/** Round-1 section of the chair prompt (between the two ROUND headings). */
function chairRound1Block(user: string): string {
  const start = user.indexOf('ROUND 1');
  const end = user.indexOf('ROUND 2');
  if (start < 0 || end < 0 || end < start) return '';
  return user.slice(start, end);
}

/** Which "Seat X" label a marker was rendered under, or null if absent. */
function labelOf(block: string, marker: string): string | null {
  const at = block.indexOf(marker);
  if (at < 0) return null;
  const seen = [...block.slice(0, at).matchAll(/Seat ([A-Z])\b/g)];
  const last = seen[seen.length - 1];
  return last ? last[1] : null;
}

const BRAND_TOKENS =
  /gemini|gpt-4o|claude|haiku|opus|anthropic|openai|google\/|mistral|llama/i;

/** Reused assertion: this prompt names no vendor and no seat's model slug. */
function assertAnonymous(label: string, prompts: string[]): void {
  const slugs = [MODEL.seat1, MODEL.seat2, MODEL.seat3, MODEL.chair];
  const slugHits = prompts.filter((p) => slugs.some((s) => p.includes(s)));
  const brandHits = prompts.filter((p) => BRAND_TOKENS.test(p));
  check(
    `${label}: no seat model slug appears in any prompt`,
    slugHits.length === 0,
    `${slugHits.length}/${prompts.length} prompt(s) leaked a slug`,
  );
  check(
    `${label}: no vendor/brand token appears in any prompt`,
    brandHits.length === 0,
    `${brandHits.length}/${prompts.length} prompt(s) matched ${String(BRAND_TOKENS)}`,
  );
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* ================================================================ */
  /* 1. Rules are presented and cited by unique ref, never bare code   */
  /* ================================================================ */
  await scenario('rule presentation is ref-disciplined, not code-disciplined', async () => {
    eq('ruleRef appends a title slug to the code', REF_RECKLESS, 'Law 12.1 :: reckless-challenge-yellow-card');
    check(
      'two rules sharing a code get distinct refs',
      REF_RECKLESS !== REF_HANDBALL && RULES[0].code === RULES[1].code,
      `${REF_RECKLESS} vs ${REF_HANDBALL}`,
    );

    const rendered = renderCandidates(RULES);
    check('candidate block presents the reckless rule by full ref', rendered.includes(`[${REF_RECKLESS}]`));
    check('candidate block presents the handball rule by full ref', rendered.includes(`[${REF_HANDBALL}]`));
    check('candidate block presents the offside rule by full ref', rendered.includes(`[${REF_OFFSIDE}]`));
    check('candidate block never presents a bare code', !rendered.includes('[Law 12.1]') && !rendered.includes('[Law 11.2]'));

    const list = refList(RULES);
    check('valid-ref list offers the reckless ref', list.includes(`"${REF_RECKLESS}"`));
    check('valid-ref list offers the handball ref', list.includes(`"${REF_HANDBALL}"`));
    check('valid-ref list never offers a bare code', !list.includes('"Law 12.1"') && !list.includes('"Law 11.2"'));
    eq(
      'valid-ref list holds one distinct entry per rule',
      new Set(list.split(', ')).size,
      RULES.length,
    );

    eqList('a bare code is not a citable reference', filterValidRuleRefs(['Law 12.1'], RULES), []);
    eqList('a full ref survives filtering', filterValidRuleRefs([REF_HANDBALL], RULES), [REF_HANDBALL]);
    eqList('an out-of-shortlist ref is dropped', filterValidRuleRefs(['Law 99.9 :: invented'], RULES), []);

    const cited = citeRulesByRef([REF_RECKLESS], RULES);
    eq('a ref resolves to exactly one rule', cited.length, 1);
    eq('a shared code resolves to the CITED rule, not the last one seen', cited[0].title, RULES[0].title);
    eq(
      'the sibling ref resolves to the sibling rule',
      citeRulesByRef([REF_HANDBALL], RULES)[0].title,
      RULES[1].title,
    );

    const prompt = buildPanelPrompt(INPUT, SEATS[0]);
    check('panel prompt carries both same-code refs', prompt.user.includes(REF_RECKLESS) && prompt.user.includes(REF_HANDBALL));
    check('panel prompt never offers a bare code as a reference', !prompt.user.includes('"Law 12.1"') && !prompt.user.includes('[Law 12.1]'));
  });

  /* ================================================================ */
  /* 2. Confident unanimity settles at the panel                       */
  /* ================================================================ */
  await scenario('a confident unanimous panel settles without debating', async () => {
    const script: StubScript = {
      [MODEL.seat1]: { panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]) },
      [MODEL.seat2]: { panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]) },
      [MODEL.seat3]: { panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat3, [REF_RECKLESS]) },
    };
    const t = installStubTransport(script);
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, testConfig());
    } finally {
      t.restore();
    }

    eq('stage is panel', result.stage, 'panel');
    eq('no debate calls were made', t.stage('debate').length, 0);
    eq('no chair call was made', t.stage('chair').length, 0);
    eq('one request per seat', t.fetchCount(), 3);
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    eq('verdict is the unanimous one', result.verdict, 'BAD_CALL');
    eqList('no failed seats', result.failedSeats, []);
    eq('cited rule resolved through the ref, not the code', result.rulesCited[0]?.title, RULES[0].title);
    eq('reliability is derived from the score it reports', result.reliability, reliabilityBand(result.accuracyScore));
    eq('a unanimous confident council is TRUSTWORTHY', result.reliability, 'TRUSTWORTHY');

    const panel = t.stage('panel');
    check('each panel prompt carries the full refs', panel.every((c) => c.user.includes(REF_RECKLESS) && c.user.includes(REF_HANDBALL)));
    check('each panel prompt offers no bare code', panel.every((c) => !c.user.includes('"Law 12.1"')));
    check(
      'each seat argues from its own lens',
      panel.find((c) => c.model === MODEL.seat1)!.system.includes('LITERALIST') &&
        panel.find((c) => c.model === MODEL.seat2)!.system.includes('PROSECUTOR') &&
        panel.find((c) => c.model === MODEL.seat3)!.system.includes('DEFENDER'),
    );
    record('unanimous panel', t);
  });

  /* ================================================================ */
  /* 3. Genuine disagreement DOES reach the debate stage               */
  /*    + anonymisation, self-exclusion, label stability, call count   */
  /* ================================================================ */
  await scenario('a split panel debates, anonymously, without seeing itself', async () => {
    const script: StubScript = {
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat1, [REF_RECKLESS]),
      },
      [MODEL.seat2]: {
        // First reply is unparseable: this seat costs TWO requests.
        panel: [GARBAGE, panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS])],
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat2, [REF_RECKLESS]),
      },
      [MODEL.seat3]: {
        panel: panelReply('FAIR_CALL', 'HIGH', 0.9, MARK.seat3, [REF_RECKLESS]),
        debate: [GARBAGE, debateReply('BAD_CALL', 'HIGH', 0.9, 'yielding: ' + MARK.seat3, [REF_RECKLESS])],
      },
    };
    const t = installStubTransport(script);
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, testConfig());
    } finally {
      t.restore();
    }

    // The property the whole escalation design exists for.
    check('a genuinely split panel does NOT settle at stage panel', result.stage !== 'panel', `stage=${result.stage}`);
    eq('the debate round actually ran', t.stage('debate').length > 0, true);
    eq('every usable seat debated', new Set(t.stage('debate').map((c) => c.model)).size, 3);
    eq('the council settled after debate', result.stage, 'debate');
    eq('every seat produced a debate statement', result.debate.length, 3);
    eq('the seat that flipped is recorded as having changed its mind', result.debate.find((d) => d.seatId === 'seat-3')?.changedMind, true);

    // Bug 1: retries are real HTTP requests and must be counted as such.
    eq('the retrying seats really made extra requests', t.fetchCount(), 8);
    eq('totalCalls equals the real request count, retries included', result.totalCalls, t.fetchCount());

    const debate = t.stage('debate');
    assertAnonymous('debate transcript', debate.map((c) => c.prompt));

    // Self-exclusion: a seat must never be shown its own opinion as a peer.
    const ownMarker: Record<string, string> = {
      [MODEL.seat1]: MARK.seat1,
      [MODEL.seat2]: MARK.seat2,
      [MODEL.seat3]: MARK.seat3,
    };
    let selfShown = 0;
    let peersMissing = 0;
    let wrongPeerCount = 0;
    for (const call of debate) {
      const block = othersBlock(call.user);
      if (block === '') {
        peersMissing += 1;
        continue;
      }
      if (block.includes(ownMarker[call.model])) selfShown += 1;
      const peers = Object.entries(ownMarker).filter(([m]) => m !== call.model);
      if (!peers.every(([, marker]) => block.includes(marker))) peersMissing += 1;
      // A three-seat council shows each seat exactly TWO peers. Counting the
      // rendered labels catches self-inclusion even if the markers changed.
      const rendered = new Set([...block.matchAll(/Seat ([A-Z])\b/g)].map((m) => m[1]));
      if (rendered.size !== 2) wrongPeerCount += 1;
    }
    eq('no seat is shown its own round-1 opinion as a peer', selfShown, 0);
    eq('every seat is shown both peers', peersMissing, 0);
    eq('every seat is shown exactly two peers, never three', wrongPeerCount, 0);
    check(
      'each seat still sees its own opinion in the OWN section',
      debate.every((c) => c.user.includes('YOUR FIRST-ROUND OPINION:') && c.user.includes(ownMarker[c.model])),
    );

    // Labels are assigned once from panel order and must not drift per seat.
    const labels = new Map<string, Set<string>>();
    for (const call of debate) {
      const block = othersBlock(call.user);
      for (const [, marker] of Object.entries(MARK)) {
        const label = labelOf(block, marker);
        if (!label) continue;
        if (!labels.has(marker)) labels.set(marker, new Set());
        labels.get(marker)!.add(label);
      }
    }
    check(
      'each seat keeps ONE stable label across every debate prompt',
      [...labels.values()].every((s) => s.size === 1),
      JSON.stringify([...labels].map(([m, s]) => [m, [...s]])),
    );
    eqList(
      'labels are the seat order A, B, C',
      [...labels.entries()].map(([, s]) => [...s][0]),
      ['A', 'B', 'C'],
    );
    record('split panel debate', t);
  });

  /* ================================================================ */
  /* 4. Chair path: score focuses the RETURNED verdict                 */
  /* ================================================================ */
  await scenario('a chair that overrules the panel is scored on its own verdict', async () => {
    const script: StubScript = {
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat1, [REF_RECKLESS]),
      },
      [MODEL.seat2]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.88, MARK.seat2, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.88, 'holding: ' + MARK.seat2, [REF_RECKLESS]),
      },
      [MODEL.seat3]: {
        panel: panelReply('INCONCLUSIVE', 'MEDIUM', 0.6, MARK.seat3, []),
        debate: debateReply('INCONCLUSIVE', 'MEDIUM', 0.6, 'holding: ' + MARK.seat3, []),
      },
      [MODEL.chair]: { chair: chairReply('FAIR_CALL', 'HIGH', 0.8, [REF_HANDBALL]) },
    };
    const t = installStubTransport(script);
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, testConfig());
    } finally {
      t.restore();
    }

    eq('the council escalated all the way to the chair', result.stage, 'chair');
    eq('the chair was called exactly once', t.stage('chair').length, 1);
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    eq('the chair verdict is returned', result.verdict, 'FAIR_CALL');
    eq('the chair citation resolves through its ref', result.rulesCited[0]?.title, RULES[1].title);
    check('the chair rationale is surfaced', Boolean(result.chairRationale));

    const positions = [
      sample('BAD_CALL', 0.9, [REF_RECKLESS]),
      sample('BAD_CALL', 0.88, [REF_RECKLESS]),
      sample('INCONCLUSIVE', 0.6, []),
    ];
    // The chair's own vote is deliberately NOT in this tally. It used to be,
    // which let the tie-breaker vote in the count measuring how contested its
    // own ruling was (worth +0.079 — enough to cross TRUSTWORTHY at the
    // margin). The score answers "how alone is this answer among the SEATS?",
    // so the chair cannot be one of the seats answering it.
    const focused = accuracyScore(computeAgreement(positions, 'FAIR_CALL', SEATS.length));
    const modal = accuracyScore(computeAgreement(positions, undefined, SEATS.length));

    close('accuracyScore is computed over the RETURNED verdict', result.accuracyScore, focused);
    check(
      'the returned-verdict score differs from the modal-verdict score',
      Math.abs(focused - modal) > 1e-6,
      `focused ${focused} vs modal ${modal}`,
    );
    check(
      'an overruled council scores below its own majority',
      result.accuracyScore < modal,
      `${result.accuracyScore} vs ${modal}`,
    );

    // `agreement` describes the COUNCIL and must stay chair-free.
    const councilSeats =
      result.agreement.distribution.FAIR_CALL +
      result.agreement.distribution.BAD_CALL +
      result.agreement.distribution.INCONCLUSIVE;
    eq('agreement counts the seats only, not the chair', councilSeats, 3);
    // `agreement` is now focused on the RETURNED verdict, not the modal one.
    // It previously shipped the modal split, so `agreement.distribution` could
    // describe a different answer than `verdict` and a UI reading both would
    // state the opposite of the ruling. Zero seats backed the chair here, and
    // that is exactly what consensusRatio should say.
    close('agreement measures support for the RETURNED verdict', result.agreement.consensusRatio, 0, 1e-9);
    eq('agreementFocus equals the returned verdict', result.agreement.agreementFocus, result.verdict);
    eq('the raw tally is still reported honestly', result.agreement.distribution.BAD_CALL, 2);
    eq('reliability follows the reported score', result.reliability, reliabilityBand(result.accuracyScore));
    check('a lone chair overrule is not reported HIGH', result.confidence !== 'HIGH', result.confidence);

    const chairCall = t.stage('chair')[0];
    assertAnonymous('chair transcript', [chairCall.prompt]);
    const round1 = chairRound1Block(chairCall.user);
    check('the chair sees all three round-1 opinions', Object.values(MARK).every((m) => round1.includes(m)));
    check('the chair sees the debate round', chairCall.user.includes('ROUND 2'));
    eqList(
      'chair labels match the debate labels A, B, C',
      Object.values(MARK).map((m) => labelOf(round1, m) ?? '?'),
      ['A', 'B', 'C'],
    );
    record('chair overrule', t);
  });

  /* ================================================================ */
  /* 5. Quorum                                                         */
  /* ================================================================ */
  await scenario('too few usable seats is a hard error, not a thin answer', async () => {
    // Shipped defaults: whatever the shipped quorum is, dropping to ONE usable
    // seat must not produce a council answer.
    const script: StubScript = {
      [MODEL.seat1]: { panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]) },
      [MODEL.seat2]: { panel: OUTAGE },
      [MODEL.seat3]: { panel: OUTAGE },
    };
    const t = installStubTransport(script);
    let caught: unknown;
    let leaked: CouncilResult | undefined;
    try {
      leaked = await runCouncil(INPUT, shippedConfig());
    } catch (err) {
      caught = err;
    } finally {
      t.restore();
    }

    check('a one-seat council throws', caught instanceof CouncilQuorumError, String(caught));
    check(
      'a one-seat council returns no answer at all',
      leaked === undefined,
      `got a ${leaked?.stage} result with ${leaked?.opinions.length} opinion(s)`,
    );
    if (caught instanceof CouncilQuorumError) {
      check('the error names the seats that failed', caught.message.includes('seat-2') && caught.message.includes('seat-3'), caught.message);
      check('the error reports how many seats were usable', caught.message.includes('1 usable'), caught.message);
      eqList('failedSeats lists both dead seats', caught.failedSeats, ['seat-2', 'seat-3']);
    }
    eq('no debate was attempted below quorum', t.stage('debate').length, 0);
    eq('no chair was attempted below quorum', t.stage('chair').length, 0);
    eq('a non-retryable seat failure costs exactly one request', t.fetchCount(), 3);
    record('quorum failure', t);
  });

  await scenario('quorum is read from the config it is given', async () => {
    const script = (): StubScript => ({
      // Two seats agree, one is dead. Before the coverage fix this settled at
      // panel (2/2 read as unanimous); it now escalates, because 2 of an
      // EXPECTED 3 is 0.667 and does not clear the consensus gate. The debate
      // and chair rounds below are scripted so this scenario keeps testing
      // QUORUM rather than incidentally testing escalation.
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
      },
      [MODEL.seat2]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]),
      },
      [MODEL.seat3]: { panel: OUTAGE },
      [MODEL.chair]: { chair: chairReply('BAD_CALL', 'HIGH', 0.9, [REF_RECKLESS]) },
    });

    const strict = installStubTransport(script());
    let caught: unknown;
    try {
      await runCouncil(INPUT, testConfig({ quorum: 3 }));
    } catch (err) {
      caught = err;
    } finally {
      strict.restore();
    }
    check('2 usable seats fail a quorum of 3', caught instanceof CouncilQuorumError, String(caught));

    const lenient = installStubTransport(script());
    let result: CouncilResult | undefined;
    let lenientErr: unknown;
    try {
      result = await runCouncil(INPUT, testConfig({ quorum: 2 }));
    } catch (err) {
      lenientErr = err;
    } finally {
      lenient.restore();
    }
    check('2 usable seats satisfy a quorum of 2', result !== undefined, String(lenientErr));
    check(
      'the dead seat is reported',
      (result?.failedSeats ?? []).includes('seat-3'),
      result?.failedSeats.join(','),
    );
    eq('the surviving seats still answer', result?.verdict, 'BAD_CALL');
    eq('totalCalls equals the real request count', result?.totalCalls, lenient.fetchCount());
    record('quorum config strict', strict);
    record('quorum config lenient', lenient);
  });

  /* ================================================================ */
  /* 6. The consensus gate is consulted, and it is the config's        */
  /* ================================================================ */
  await scenario('the consensus gate escalates exactly what the config says it should', async () => {
    // Identical 2-1 panel, two different thresholds, two different outcomes.
    const script = (): StubScript => ({
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat1, [REF_RECKLESS]),
      },
      [MODEL.seat2]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat2, [REF_RECKLESS]),
      },
      [MODEL.seat3]: {
        panel: panelReply('FAIR_CALL', 'HIGH', 0.9, MARK.seat3, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'yielding: ' + MARK.seat3, [REF_RECKLESS]),
      },
    });

    const strict = installStubTransport(script());
    let escalated: CouncilResult;
    try {
      escalated = await runCouncil(INPUT, testConfig({ consensusThreshold: 0.99 }));
    } finally {
      strict.restore();
    }
    check('a 2-1 panel below the configured threshold escalates', escalated.stage !== 'panel', `stage=${escalated.stage}`);
    eq('...and it escalates by debating', strict.stage('debate').length, 3);

    const lenient = installStubTransport(script());
    let settledEarly: CouncilResult;
    try {
      settledEarly = await runCouncil(INPUT, testConfig({ consensusThreshold: 0.6 }));
    } finally {
      lenient.restore();
    }
    eq('the same panel above a looser configured threshold settles', settledEarly.stage, 'panel');
    eq('...and never debates', lenient.stage('debate').length, 0);

    // Same data, opposite outcomes: proves the gate reads the config rather
    // than any constant baked into the module.
    check(
      'identical panels differ only by the configured threshold',
      escalated.stage !== settledEarly.stage,
      `${escalated.stage} vs ${settledEarly.stage}`,
    );

    // A settled answer that still carries a live dissent must not be sold as
    // trustworthy - this is the property the TRUSTWORTHY cut-point encodes.
    check(
      'a settled-but-dissenting council is not TRUSTWORTHY',
      settledEarly.reliability !== 'TRUSTWORTHY',
      `${settledEarly.reliability} @ ${settledEarly.accuracyScore}`,
    );
    record('consensus gate strict', strict);
    record('consensus gate lenient', lenient);
  });

  await scenario('under the shipped defaults, a live dissent still buys a debate round', async () => {
    const t = installStubTransport({
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat1, [REF_RECKLESS]),
      },
      [MODEL.seat2]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'holding: ' + MARK.seat2, [REF_RECKLESS]),
      },
      [MODEL.seat3]: {
        panel: panelReply('FAIR_CALL', 'HIGH', 0.9, MARK.seat3, [REF_RECKLESS]),
        debate: debateReply('BAD_CALL', 'HIGH', 0.9, 'yielding: ' + MARK.seat3, [REF_RECKLESS]),
      },
    });
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, shippedConfig());
    } finally {
      t.restore();
    }
    check('one dissenting seat out of three escalates', result.stage !== 'panel', `stage=${result.stage}`);
    eq('the debate round ran under the shipped config', t.stage('debate').length, 3);
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    record('shipped-default escalation', t);
  });

  await scenario('unanimous but collectively unsure still escalates', async () => {
    // No selfProbability at all: each seat falls back to its LOW midpoint, so
    // the panel is unanimous and knows nothing.
    const t = installStubTransport({
      [MODEL.seat1]: {
        panel: panelReply('INCONCLUSIVE', 'LOW', undefined, MARK.seat1, []),
        debate: debateReply('INCONCLUSIVE', 'LOW', undefined, 'holding: ' + MARK.seat1, []),
      },
      [MODEL.seat2]: {
        panel: panelReply('INCONCLUSIVE', 'LOW', undefined, MARK.seat2, []),
        debate: debateReply('INCONCLUSIVE', 'LOW', undefined, 'holding: ' + MARK.seat2, []),
      },
      [MODEL.seat3]: {
        panel: panelReply('INCONCLUSIVE', 'LOW', undefined, MARK.seat3, []),
        debate: debateReply('INCONCLUSIVE', 'LOW', undefined, 'holding: ' + MARK.seat3, []),
      },
      [MODEL.chair]: { chair: chairReply('INCONCLUSIVE', 'LOW', 0.3, []) },
    });
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, shippedConfig());
    } finally {
      t.restore();
    }
    check('agreement about not knowing is not consensus', result.stage !== 'panel', `stage=${result.stage}`);
    eq('an unresolved council reaches the chair', result.stage, 'chair');
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    // NOTE: this council escalates all the way to the chair and STILL scores
    // high, because unanimity + empty citation sets + zero entropy outweigh a
    // mean probability of 0.26. That is the known degraded-panel scoring wart;
    // it is deliberately not asserted against here, and not fixed here. All
    // this pins is that the two fields agree with each other.
    eq('reliability is derived from the score it reports', result.reliability, reliabilityBand(result.accuracyScore));
    record('unsure unanimity', t);
  });

  /* ================================================================ */
  /* 7. Baseline arm reports the model's own probability, unscaled     */
  /* ================================================================ */
  await scenario('the baseline arm reports its self-probability faithfully', async () => {
    const t = installStubTransport({
      [MODEL.seat1]: {
        panel: [GARBAGE, panelReply('BAD_CALL', 'HIGH', 0.82, 'baseline reasoning', [REF_RECKLESS])],
      },
    });
    let result: CouncilResult;
    try {
      result = await runSingleModel(INPUT, testConfig());
    } finally {
      t.restore();
    }

    eq('the opinion keeps the stated probability', result.opinions[0].selfProbability, 0.82);
    eq('accuracyScore IS the self-probability, unscaled', result.accuracyScore, 0.82);
    eq('reliability follows that score', result.reliability, reliabilityBand(0.82));
    eq('one seat, one opinion', result.opinions.length, 1);
    eq('the baseline never debates', result.debate.length, 0);
    eq('the retry really happened', t.fetchCount(), 2);
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    eq('only the baseline model was called', new Set(t.calls.map((c) => c.model)).size, 1);

    const pct = installStubTransport({
      [MODEL.seat1]: { panel: panelReply('BAD_CALL', 'HIGH', 82 as unknown as number, 'baseline reasoning', [REF_RECKLESS]) },
    });
    let asPercent: CouncilResult;
    try {
      asPercent = await runSingleModel(INPUT, testConfig());
    } finally {
      pct.restore();
    }
    eq('a percentage self-probability is rescaled once, to 0..1', asPercent.accuracyScore, 0.82);

    const disabled = installStubTransport({
      [MODEL.seat1]: { panel: panelReply('BAD_CALL', 'HIGH', 0.82, 'baseline reasoning', [REF_RECKLESS]) },
    });
    let viaCouncil: CouncilResult;
    try {
      viaCouncil = await runCouncil(INPUT, testConfig({ enabled: false }));
    } finally {
      disabled.restore();
    }
    eq('a disabled council runs the single-model arm', viaCouncil.opinions.length, 1);
    eq('...with the same unscaled score', viaCouncil.accuracyScore, 0.82);
    eq('...and one request', disabled.fetchCount(), 1);
    record('baseline arm', t);
    record('baseline percent', pct);
    record('baseline via disabled council', disabled);
  });

  /* ================================================================ */
  /* 8. Seats that die in the debate round are reported                */
  /* ================================================================ */
  await scenario('failed seats from every round are reported, deduplicated', async () => {
    const t = installStubTransport({
      [MODEL.seat1]: {
        panel: panelReply('BAD_CALL', 'HIGH', 0.9, MARK.seat1, [REF_RECKLESS]),
        debate: OUTAGE,
      },
      [MODEL.seat2]: {
        panel: panelReply('FAIR_CALL', 'HIGH', 0.9, MARK.seat2, [REF_RECKLESS]),
        debate: OUTAGE,
      },
      [MODEL.seat3]: { panel: OUTAGE },
      [MODEL.chair]: { chair: chairReply('BAD_CALL', 'MEDIUM', 0.7, [REF_RECKLESS]) },
    });
    let result: CouncilResult;
    try {
      result = await runCouncil(INPUT, testConfig());
    } finally {
      t.restore();
    }

    eqList(
      'failedSeats unions the panel round and the debate round',
      result.failedSeats,
      ['seat-1', 'seat-2', 'seat-3'],
    );
    eq('failedSeats has no duplicates', new Set(result.failedSeats).size, result.failedSeats.length);
    eq('a debate wipeout still reaches the chair', result.stage, 'chair');
    eq('no debate statement survived', result.debate.length, 0);
    eq('the seats that survived round 1 keep their opinions', result.opinions.filter((o) => !o.error).length, 2);
    eq('totalCalls equals the real request count', result.totalCalls, t.fetchCount());
    eq('three panel + two debate + one chair request', t.fetchCount(), 6);
    record('debate wipeout', t);
  });

  /* ================================================================ */
  /* 9. An abort must not be reported as "undefined"                   */
  /* ================================================================ */
  await scenario('an already-aborted seat reports why it aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const t = installStubTransport({});
    let caught: unknown;
    try {
      await councilChatJson(
        { seat: SEATS[0], system: 'system', user: 'user', signal: controller.signal },
        PanelResponseSchema,
      );
    } catch (err) {
      caught = err;
    } finally {
      t.restore();
    }

    check('an aborted call throws CouncilCallError', caught instanceof CouncilCallError, String(caught));
    const message = caught instanceof Error ? caught.message : String(caught);
    check('the error is not the string "undefined"', message !== 'undefined', message);
    check('the error does not contain "undefined"', !message.includes('undefined'), message);
    check('the error names the seat', message.includes('seat-1'), message);
    check('the error explains the abort', /abort|deadline/i.test(message), message);
    eq('an aborted call sends no request', t.fetchCount(), 0);

    // The same failure as it reaches PanelOpinion.error (and, downstream, the
    // eval CaseOutcome.error).
    const panelStub = installStubTransport({});
    let panel;
    try {
      panel = await runPanel(INPUT, testConfig(), controller.signal);
    } finally {
      panelStub.restore();
    }
    eq('every seat fails under an aborted deadline', panel.failedSeats.length, 3);
    eq('no request escapes after the abort', panelStub.fetchCount(), 0);
    check(
      'no PanelOpinion.error is "undefined"',
      panel.opinions.every((o) => Boolean(o.error) && !o.error!.includes('undefined')),
      JSON.stringify(panel.opinions.map((o) => o.error)),
    );
    check(
      'every PanelOpinion.error explains the abort',
      panel.opinions.every((o) => /abort|deadline/i.test(o.error ?? '')),
      JSON.stringify(panel.opinions.map((o) => o.error)),
    );
    record('aborted seat', panelStub);
  });

  /* ================================================================ */
  /* 10. Reliability bands: relationships, not literals                */
  /* ================================================================ */
  await scenario('reliability bands keep their ordering and their meaning', async () => {
    check('TRUSTWORTHY sits strictly above REVIEW_SUGGESTED', TRUSTWORTHY_MIN > REVIEW_SUGGESTED_MIN, `${TRUSTWORTHY_MIN} vs ${REVIEW_SUGGESTED_MIN}`);
    eq('the trustworthy cut-point is itself TRUSTWORTHY', reliabilityBand(TRUSTWORTHY_MIN), 'TRUSTWORTHY');
    eq('just below it is not', reliabilityBand(TRUSTWORTHY_MIN - 1e-9), 'REVIEW_SUGGESTED');
    eq('the review cut-point is itself REVIEW_SUGGESTED', reliabilityBand(REVIEW_SUGGESTED_MIN), 'REVIEW_SUGGESTED');
    eq('just below it is UNRELIABLE', reliabilityBand(REVIEW_SUGGESTED_MIN - 1e-9), 'UNRELIABLE');

    const rank = { UNRELIABLE: 0, REVIEW_SUGGESTED: 1, TRUSTWORTHY: 2 } as const;
    let monotone = true;
    for (let s = 0; s <= 1.0001; s += 0.01) {
      if (rank[reliabilityBand(s)] < rank[reliabilityBand(Math.max(0, s - 0.01))]) monotone = false;
    }
    check('a higher score never lands in a lower band', monotone);

    // The meaning of the cut-point, stated without naming its value: a council
    // carrying a live dissent is not trustworthy even when every seat is
    // maximally confident and they all cite the same rule.
    const unanimous = accuracyScore(
      computeAgreement([
        sample('BAD_CALL', 0.9, [REF_RECKLESS]),
        sample('BAD_CALL', 0.9, [REF_RECKLESS]),
        sample('BAD_CALL', 0.9, [REF_RECKLESS]),
      ]),
    );
    const dissenting = accuracyScore(
      computeAgreement([
        sample('BAD_CALL', 0.9, [REF_RECKLESS]),
        sample('BAD_CALL', 0.9, [REF_RECKLESS]),
        sample('FAIR_CALL', 0.9, [REF_RECKLESS]),
      ]),
    );
    check('one dissent costs score', dissenting < unanimous, `${dissenting} vs ${unanimous}`);
    eq('a unanimous, confident, co-citing council IS trustworthy', reliabilityBand(unanimous), 'TRUSTWORTHY');
    check(
      'a confident, co-citing council with ONE dissent is NOT trustworthy',
      reliabilityBand(dissenting) !== 'TRUSTWORTHY',
      `band=${reliabilityBand(dissenting)} score=${dissenting}`,
    );
    check(
      'that dissenting council is still worth reviewing, not garbage',
      reliabilityBand(dissenting) === 'REVIEW_SUGGESTED',
      `band=${reliabilityBand(dissenting)} score=${dissenting}`,
    );
  });

  /* ================================================================ */
  /* 11. Cross-scenario invariants                                     */
  /* ================================================================ */
  console.log('\ncross-scenario invariants');
  {
    const debateAndChair = allPrompts.filter((p) => p.stage !== 'panel');
    check('debate and chair prompts were actually captured', debateAndChair.length > 0, `${debateAndChair.length}`);
    assertAnonymous('every captured debate/chair prompt', debateAndChair.map((p) => p.prompt));
    assertAnonymous('every captured panel prompt', allPrompts.filter((p) => p.stage === 'panel').map((p) => p.prompt));
    check(
      'no prompt ever offered a bare shared code as a citable ref',
      allPrompts.every((p) => !p.prompt.includes('"Law 12.1"')),
    );
  }

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
    console.log('council mechanism tests OK\n');
  })
  .catch((err) => {
    console.error('\nTest harness crashed:', err);
    process.exit(1);
  });

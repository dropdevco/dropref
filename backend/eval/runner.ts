/**
 * Executes one arm (baseline or council) over a golden set.
 *
 * DEPENDENCY INVERSION: this module never imports backend/council/index.ts. An
 * arm is just a function with the shape below, supplied by the caller. That
 * keeps the whole harness runnable — and unit-testable — with a stub arm, with
 * no network and no API key, and keeps it building while the council
 * implementation is still being written by someone else.
 */

import fs from 'fs';
import path from 'path';
import type { SportCorpus, SportId } from '../../types/contract';
import type { CouncilInput, CouncilResult } from '../council/types';
import { ruleRef } from '../council/rule-ref';
import { retrieveRules } from '../rules/retrieve';
import { getSportCorpus } from '../sports';
import type { CacheEntry, CacheFile, CacheKeyComponents } from './cache';
import {
  cacheEntryReusable,
  cacheKey,
  emptyCache,
  loadCache,
  makeCacheEntry,
  saveCache,
  staleSiblings,
} from './cache';
import type { RunFingerprint } from './fingerprint';
import { buildRunFingerprint, fingerprintDigest } from './fingerprint';
import type { ArmName } from './metrics';
import { defaultScoreKind, scoreCase } from './metrics';
import type { CaseOutcome, GoldenCase, GoldenSet, ScoreKind } from './types';

export type { CacheEntry, CacheFile, CacheKeyComponents };
export { cacheEntryReusable, cacheKey };

/** The only thing the runner needs to know about an arm. */
export type Arm = (input: CouncilInput) => Promise<CouncilResult>;

export const ALL_SPORTS: SportId[] = ['soccer', 'football', 'lacrosse'];

/** Directory holding the golden-set JSON files. */
export const GOLDEN_DIR = path.join(process.cwd(), 'backend', 'eval', 'golden');

/** Default results/cache directory (gitignored). */
export const RESULTS_DIR = path.join(process.cwd(), 'backend', 'eval', 'results');

export interface RunOptions {
  /** Which arm label to stamp on every outcome. */
  arm: ArmName;
  /** Parallel in-flight cases. Kept low by default to stay under OpenRouter rate limits. */
  concurrency?: number;
  /** Shortlist size handed to the arm. Matches backend/ai/pipeline.ts. */
  k?: number;
  /** Only run the first N cases (after ordering). For smoke runs. */
  limit?: number;
  /**
   * Deterministic case ordering. Cases are always sorted by id first; a seed
   * additionally applies a seeded Fisher-Yates shuffle, so `--limit` picks a
   * reproducible pseudo-random subset instead of always the alphabetical head.
   */
  seed?: number;
  /** Golden-set version, part of the cache key. */
  goldenVersion: string;
  /**
   * Everything that determines the answers, hashed into the cache key.
   *
   * REQUIRED whenever `cachePath` is set. Without it there is no way to tell a
   * cached outcome produced by the current configuration from one produced by
   * a different model roster, a different `k`, or a different council build —
   * which is exactly the hole defect B3 exploited. When omitted, caching is
   * disabled outright rather than falling back to a weak key.
   */
  fingerprint?: RunFingerprint;
  /** Path to the resume cache, or null to disable caching. */
  cachePath?: string | null;
  /** Which kind of claimed probability this arm emits. See ScoreKind. */
  scoreKind?: ScoreKind;
  /** Set false to silence stderr progress. */
  progress?: boolean;
  /** Retries for transient failures, per case. Default 1. */
  retries?: number;
  /** Backoff before the retry, ms. Default 1500. */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Golden set loading
// ---------------------------------------------------------------------------

function isGoldenSet(value: unknown): value is GoldenSet {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sport === 'string' &&
    typeof v.version === 'string' &&
    Array.isArray(v.cases)
  );
}

/**
 * Read `backend/eval/golden/*.json`.
 *
 * These files are authored separately and may not exist yet. A missing or
 * malformed file is reported by path on stderr and skipped — it never throws,
 * because a half-populated golden directory should still let you smoke-test the
 * harness against whatever IS there.
 */
export function loadGoldenSets(sports?: SportId[]): GoldenSet[] {
  if (!fs.existsSync(GOLDEN_DIR)) {
    process.stderr.write(
      `[eval] golden directory not found: ${GOLDEN_DIR}\n` +
        `[eval] expected one JSON file per sport, e.g. ${path.join(GOLDEN_DIR, 'soccer.json')}\n`,
    );
    return [];
  }

  const wanted =
    sports && sports.length > 0
      ? sports
      : (fs
          .readdirSync(GOLDEN_DIR)
          .filter((f) => f.endsWith('.json'))
          .map((f) => path.basename(f, '.json'))
          .filter((id): id is SportId => (ALL_SPORTS as string[]).includes(id)));

  if (wanted.length === 0) {
    process.stderr.write(
      `[eval] no golden-set files found in ${GOLDEN_DIR} (expected e.g. soccer.json)\n`,
    );
    return [];
  }

  const sets: GoldenSet[] = [];
  for (const sport of wanted) {
    const filePath = path.join(GOLDEN_DIR, `${sport}.json`);
    if (!fs.existsSync(filePath)) {
      process.stderr.write(
        `[eval] golden set for "${sport}" not found at ${filePath} — skipping this sport.\n`,
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      process.stderr.write(
        `[eval] golden set at ${filePath} is not valid JSON (${errorMessage(err)}) — skipping.\n`,
      );
      continue;
    }
    if (!isGoldenSet(parsed)) {
      process.stderr.write(
        `[eval] golden set at ${filePath} is missing required fields ` +
          `(sport, version, cases[]) — skipping.\n`,
      );
      continue;
    }
    sets.push(parsed);
  }
  return sets;
}

/** Flatten loaded sets into a single case list. */
export function casesOf(sets: GoldenSet[]): GoldenCase[] {
  return sets.flatMap((s) => s.cases);
}

/** A single version string for a set of golden files, used in the cache key. */
export function goldenVersionOf(sets: GoldenSet[]): string {
  if (sets.length === 0) return 'none';
  return sets
    .map((s) => `${s.sport}@${s.version}`)
    .sort()
    .join('+');
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/** Small deterministic PRNG — no dependency, reproducible across machines. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Canonical ordering: sort by id (stable regardless of file order), then
 * optionally seeded-shuffle. Two runs with the same seed see the same order,
 * which is what makes `--limit` subsets comparable across arms.
 */
export function orderCases(cases: GoldenCase[], seed?: number, limit?: number): GoldenCase[] {
  const ordered = [...cases].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (seed !== undefined && Number.isFinite(seed)) {
    const rand = mulberry32(seed);
    for (let i = ordered.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = ordered[i];
      ordered[i] = ordered[j];
      ordered[j] = tmp;
    }
  }
  return limit && limit > 0 ? ordered.slice(0, limit) : ordered;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Transient == worth exactly one retry: rate limits, 5xx, timeouts, socket
 * resets. A schema/validation error is NOT transient — retrying it just burns
 * tokens to get the same answer.
 */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  if (typeof status === 'number' && (status === 429 || status === 408 || status >= 500)) {
    return true;
  }
  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('etimedout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('overloaded') ||
    msg.includes('service unavailable') ||
    msg.includes('bad gateway') ||
    /\b5\d\d\b/.test(msg)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ---------------------------------------------------------------------------
// Resume cache
// ---------------------------------------------------------------------------

/**
 * The key, the entry format, the reuse decision and the persistence all live in
 * ./cache.ts so they can be unit-tested without loading a corpus. See that file
 * for why the old `arm::caseId::goldenVersion` key was a measurement hazard.
 *
 * Re-exported above for callers that used to import them from here.
 */
export { buildRunFingerprint, fingerprintDigest };
export type { RunFingerprint };

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

const corpusCache = new Map<SportId, SportCorpus>();

function corpusFor(sport: SportId): SportCorpus {
  const cached = corpusCache.get(sport);
  if (cached) return cached;
  const corpus = getSportCorpus(sport);
  corpusCache.set(sport, corpus);
  return corpus;
}

/**
 * Build the retrieval query exactly the way backend/ai/pipeline.ts does, so the
 * shortlist the harness measures is the shortlist production produces.
 */
export function buildQuery(golden: Pick<GoldenCase, 'observation' | 'originalCall'>): string {
  return golden.originalCall
    ? `${golden.originalCall} ${golden.observation}`
    : golden.observation;
}

export interface PreparedCase {
  input: CouncilInput;
  retrievedRefs: string[];
}

/** Corpus lookup + retrieval + ref mapping for one case. Pure-ish, no network. */
export function prepareCase(golden: GoldenCase, k = 5): PreparedCase {
  const corpus = corpusFor(golden.sport);
  const shortlist = retrieveRules(corpus, buildQuery(golden), k);

  // retrieveRules returns CitedRule (no keywords/callTypes), but CouncilInput
  // wants full SportRule. Map back through the corpus BY REF, never by bare
  // code — soccer reuses "Law 12.1" across five distinct rules, so a
  // code-keyed lookup would silently hand the arm the wrong rule body.
  const byRef = new Map(corpus.rules.map((r) => [ruleRef(r), r]));
  const retrievedRefs: string[] = [];
  const candidates = [];
  for (const cited of shortlist) {
    const ref = ruleRef({ code: cited.code, title: cited.title });
    const rule = byRef.get(ref);
    if (!rule) continue;
    retrievedRefs.push(ref);
    candidates.push(rule);
  }

  return {
    input: {
      sport: golden.sport,
      displayName: corpus.displayName,
      observation: golden.observation,
      originalCall: golden.originalCall,
      candidates,
    },
    retrievedRefs,
  };
}

function erroredOutcome(
  golden: GoldenCase,
  arm: ArmName,
  message: string,
  latencyMs: number,
  modelCalls: number,
  scoreKind: ScoreKind = defaultScoreKind(arm),
): CaseOutcome {
  return {
    caseId: golden.id,
    arm,
    expectedVerdict: golden.expectedVerdict,
    // A case that never produced an answer is recorded as INCONCLUSIVE for
    // shape only; `error` is set, so aggregate() excludes it from accuracy and
    // counts it in errorRate instead.
    actualVerdict: 'INCONCLUSIVE',
    verdictCorrect: false,
    expectedRuleRefs: [...new Set(golden.expectedRuleRefs)],
    actualRuleRefs: [],
    rulePrecision: 0,
    ruleRecall: 0,
    ruleF1: 0,
    retrievalHit: false,
    claimedProbability: 0,
    scoreKind,
    difficulty: golden.difficulty,
    tag: golden.tag,
    error: message,
    latencyMs,
    modelCalls,
  };
}

/** Bounded worker pool. No dependency; results land in input order. */
async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    }),
  );
  return results;
}

export interface RunArmResult {
  outcomes: CaseOutcome[];
  /** How many outcomes came from the resume cache — i.e. were NOT re-invoked. */
  cacheHits: number;
  /** Cases whose cached entry was REFUSED because the configuration moved. */
  cacheRefusals: number;
  /** The fingerprint this run was keyed on, or null when caching was off. */
  fingerprint: RunFingerprint | null;
}

/**
 * Run one arm over the given cases.
 *
 * Guarantees:
 *  - concurrency-limited (default 4)
 *  - one retry on transient failures, with backoff
 *  - a thrown case becomes an errored CaseOutcome; the run continues
 *  - progress on stderr (a 125-case x 2-arm run is slow, and silence looks hung)
 *  - completed cases are cached so an interrupted run resumes for free — but
 *    ONLY under a full run fingerprint, and a fingerprint mismatch is announced
 *    on stderr with a field-by-field diff rather than silently re-run
 *  - caching is DISABLED, loudly, when no fingerprint is supplied: a weak key
 *    is worse than no cache, because it fabricates improvements silently
 */
export async function runArm(
  arm: Arm,
  cases: GoldenCase[],
  opts: RunOptions,
): Promise<RunArmResult> {
  const {
    arm: armName,
    concurrency = 4,
    k = 5,
    limit,
    seed,
    goldenVersion,
    fingerprint,
    cachePath = path.join(RESULTS_DIR, '.run-cache.json'),
    progress = true,
    retries = 1,
    retryDelayMs = 1500,
    scoreKind = defaultScoreKind(armName),
  } = opts;

  const note = (msg: string): void => {
    if (progress) process.stderr.write(msg);
  };
  // Warnings are NOT gated on `progress`. A silenced cache refusal is the exact
  // failure this fix exists to prevent.
  const warn = (msg: string): void => {
    process.stderr.write(msg);
  };

  let effectiveCachePath = cachePath;
  if (effectiveCachePath && !fingerprint) {
    warn(
      `[eval] ================================================================\n` +
        `[eval] DISABLING the resume cache: no run fingerprint was supplied.\n` +
        `[eval] Without one the key cannot include the model roster, k, escalation\n` +
        `[eval] thresholds, ACCURACY_WEIGHTS or the council source hash, so a cached\n` +
        `[eval] outcome could not be shown to belong to this configuration.\n` +
        `[eval] Every case will be run. This is deliberate — see defect B3.\n` +
        `[eval] ================================================================\n`,
    );
    effectiveCachePath = null;
  }
  if (fingerprint?.incomplete) {
    warn(
      `[eval] WARNING: the run fingerprint is INCOMPLETE — the seat roster, chair,\n` +
        `[eval] escalation thresholds or ACCURACY_WEIGHTS could not be resolved, so the\n` +
        `[eval] cache key falls back to the council source hash and the COUNCIL_* env\n` +
        `[eval] digest alone. Those still catch code and override changes, but the\n` +
        `[eval] fingerprint recorded in the report will be less informative.\n`,
    );
  }

  const selected = orderCases(cases, seed, limit);
  const cache = effectiveCachePath ? loadCache(effectiveCachePath, warn) : emptyCache();
  const total = selected.length;
  let completed = 0;
  let cacheHits = 0;
  let cacheRefusals = 0;

  const componentsFor = (caseId: string): CacheKeyComponents | null =>
    fingerprint ? { arm: armName, caseId, goldenVersion, fingerprint } : null;

  const store = (components: CacheKeyComponents | null, outcome: CaseOutcome): void => {
    if (!effectiveCachePath || !components) return;
    const entry = makeCacheEntry(components, outcome);
    cache.entries[entry.key] = entry;
    saveCache(effectiveCachePath, cache, warn);
  };

  note(
    `[eval] arm=${armName} cases=${total} concurrency=${concurrency} k=${k} ` +
      `golden=${goldenVersion}${seed !== undefined ? ` seed=${seed}` : ''}` +
      `${fingerprint ? ` fingerprint=${fingerprintDigest(fingerprint)}` : ' cache=off'}\n`,
  );

  const outcomes = await runPool(selected, concurrency, async (golden) => {
    const components = componentsFor(golden.id);

    if (effectiveCachePath && components) {
      const key = cacheKey(components);
      const stored = cache.entries[key];
      const decision = stored ? cacheEntryReusable(stored, components) : null;
      if (decision?.reusable) {
        completed += 1;
        cacheHits += 1;
        note(`[eval] ${armName} ${completed}/${total} ${golden.id} (cached, NOT re-invoked)\n`);
        return decision.outcome;
      }
      if (decision && !decision.reusable) {
        cacheRefusals += 1;
        warn(
          `[eval] REFUSING cached ${armName}/${golden.id}: ${decision.reason}\n` +
            decision.changed.map((line) => `[eval]   ${line}\n`).join(''),
        );
      } else {
        // No entry under this key. If entries exist for the same arm/case under
        // a DIFFERENT fingerprint, the configuration moved — say so once per
        // case rather than letting a full re-run look like an empty cache.
        const stale = staleSiblings(cache, components);
        if (stale.length > 0) {
          cacheRefusals += 1;
          warn(
            `[eval] REFUSING ${stale.length} cached entr${stale.length === 1 ? 'y' : 'ies'} for ` +
              `${armName}/${golden.id}: run fingerprint changed since they were stored ` +
              `(${stale.map((s) => s.fingerprintDigest).join(', ')} -> ` +
              `${fingerprintDigest(fingerprint as RunFingerprint)}). Re-running.\n`,
          );
        }
      }
    }

    let prepared: PreparedCase;
    try {
      prepared = prepareCase(golden, k);
    } catch (err) {
      completed += 1;
      const outcome = erroredOutcome(
        golden,
        armName,
        `prepare: ${errorMessage(err)}`,
        0,
        0,
        scoreKind,
      );
      note(`[eval] ${armName} ${completed}/${total} ${golden.id} PREPARE-ERROR\n`);
      // NOT cached: like any other error, a resumed run should retry it.
      return outcome;
    }

    const startedAt = Date.now();
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const result = await arm(prepared.input);
        const outcome = scoreCase(golden, result, prepared.retrievedRefs, armName, scoreKind);
        completed += 1;
        note(
          `[eval] ${armName} ${completed}/${total} ${golden.id} ` +
            `${outcome.verdictCorrect ? 'OK ' : 'MISS'} ` +
            `exp=${outcome.expectedVerdict} got=${outcome.actualVerdict} ` +
            `${outcome.latencyMs}ms\n`,
        );
        store(components, outcome);
        return outcome;
      } catch (err) {
        lastError = err;
        const canRetry = attempt < retries && isTransientError(err);
        if (!canRetry) break;
        note(
          `[eval] ${armName} ${golden.id} transient failure ` +
            `(${errorMessage(err)}) — retrying in ${retryDelayMs}ms\n`,
        );
        await delay(retryDelayMs);
      }
    }

    completed += 1;
    const outcome = erroredOutcome(
      golden,
      armName,
      errorMessage(lastError),
      Date.now() - startedAt,
      0,
      scoreKind,
    );
    note(`[eval] ${armName} ${completed}/${total} ${golden.id} ERROR ${outcome.error}\n`);
    // Errors are deliberately NOT cached: a resumed run should retry them.
    return outcome;
  });

  const errors = outcomes.filter((o) => o.error).length;
  note(
    `[eval] arm=${armName} done: ${total} cases, ${cacheHits} from cache, ` +
      `${cacheRefusals} cache refusal(s), ${errors} errored\n`,
  );
  if (cacheHits > 0) {
    warn(
      `[eval] NOTE: ${cacheHits}/${total} ${armName} outcomes were REUSED from the resume ` +
        `cache and the arm was not invoked for them. Re-run with --no-cache for a clean ` +
        `measurement.\n`,
    );
  }
  return { outcomes, cacheHits, cacheRefusals, fingerprint: fingerprint ?? null };
}

/**
 * The resume cache (defect B3).
 *
 * Kept in its own module, separate from runner.ts, for one reason: the key and
 * the reuse decision must be unit-testable with no corpus load, no retrieval
 * and no network. Everything below the "Persistence" heading touches fs;
 * everything above it is pure.
 *
 * WHAT CHANGED
 * ------------
 * The old key was `${arm}::${caseId}::${goldenVersion}`. It mentioned nothing
 * that determines the answer, and the default cache path is gitignored, so it
 * outlived every code change. The key now includes a digest of a full
 * RunFingerprint (k, seat roster, chair, escalation thresholds,
 * ACCURACY_WEIGHTS, a content hash of backend/council/**, the COUNCIL_* env
 * block and the harness version), and each entry records the fingerprint it
 * was produced under so a mismatch can be explained rather than merely missed.
 *
 * A refusal is announced on stderr with a field-by-field diff. Silence is the
 * failure mode that made the old cache dangerous: a run that reuses stale
 * answers looks exactly like a run that recomputed them.
 */

import fs from 'fs';
import path from 'path';
import type { RunFingerprint } from './fingerprint';
import { canonicalJson, diffFingerprints, fingerprintDigest, sha256 } from './fingerprint';
import type { CaseOutcome } from './types';

export type ArmName = 'baseline' | 'council';

/** Everything the key is derived from. */
export interface CacheKeyComponents {
  arm: ArmName;
  caseId: string;
  goldenVersion: string;
  fingerprint: RunFingerprint;
}

/** One cached outcome, with the provenance needed to refuse it later. */
export interface CacheEntry {
  key: string;
  arm: ArmName;
  caseId: string;
  goldenVersion: string;
  /** The FULL fingerprint this outcome was produced under, not just its digest. */
  fingerprint: RunFingerprint;
  /** fingerprintDigest(fingerprint), stored so tampering is detectable. */
  fingerprintDigest: string;
  outcome: CaseOutcome;
  storedAt: string;
}

/** On-disk shape. Versioned so a pre-B3 flat cache is recognised and refused. */
export interface CacheFile {
  cacheFormat: 2;
  entries: Record<string, CacheEntry>;
}

export const CACHE_FORMAT = 2 as const;

// ---------------------------------------------------------------------------
// Key (pure)
// ---------------------------------------------------------------------------

/**
 * Cache key: an outcome is only reusable for the same arm, case, golden version
 * AND run fingerprint.
 *
 * The fingerprint digest is the whole point. Without it, changing the arm's
 * answers and `k` and re-running produced byte-identical outcomes because the
 * new arm was never invoked.
 */
export function cacheKey(components: CacheKeyComponents): string {
  const digest = fingerprintDigest(components.fingerprint);
  return `${components.arm}::${components.caseId}::${components.goldenVersion}::${digest}`;
}

export type CacheDecision =
  | { reusable: true; outcome: CaseOutcome }
  | { reusable: false; reason: string; changed: string[] };

/**
 * Decide whether a stored entry may be reused.
 *
 * Refuses — never silently accepts — when:
 *  - the entry is malformed, or its recorded key does not match its own fields;
 *  - the recorded fingerprint digest does not match the recorded fingerprint
 *    (someone edited the cache file);
 *  - arm / caseId / goldenVersion differ;
 *  - the fingerprint differs in any field, with the differing fields named.
 *
 * `changed` exists so the refusal can be explained. An operator who is told
 * "k: 5 -> 7" learns that the cache did its job; an operator who is told
 * nothing learns to distrust the harness.
 */
export function cacheEntryReusable(
  entry: unknown,
  expected: CacheKeyComponents,
): CacheDecision {
  if (!entry || typeof entry !== 'object') {
    return { reusable: false, reason: 'entry is not an object', changed: [] };
  }
  const e = entry as Partial<CacheEntry>;

  // A pre-B3 cache stored bare CaseOutcomes at the top level. Those carry no
  // provenance at all, so there is no way to know what produced them.
  if (!e.fingerprint || typeof e.fingerprint !== 'object' || !e.outcome) {
    return {
      reusable: false,
      reason:
        'entry has no recorded run fingerprint (pre-B3 cache format) — it cannot be shown ' +
        'to have been produced by the current configuration',
      changed: [],
    };
  }

  const recordedDigest = fingerprintDigest(e.fingerprint as RunFingerprint);
  if (e.fingerprintDigest !== recordedDigest) {
    return {
      reusable: false,
      reason: `entry digest ${String(e.fingerprintDigest)} does not match its own recorded fingerprint (${recordedDigest}) — cache file was edited`,
      changed: [],
    };
  }

  const identity: string[] = [];
  if (e.arm !== expected.arm) identity.push(`arm: ${String(e.arm)} -> ${expected.arm}`);
  if (e.caseId !== expected.caseId) identity.push(`caseId: ${String(e.caseId)} -> ${expected.caseId}`);
  if (e.goldenVersion !== expected.goldenVersion) {
    identity.push(`goldenVersion: ${String(e.goldenVersion)} -> ${expected.goldenVersion}`);
  }
  if (identity.length > 0) {
    return { reusable: false, reason: 'entry is for a different arm/case/golden set', changed: identity };
  }

  if (e.key !== cacheKey({ ...expected, fingerprint: e.fingerprint as RunFingerprint })) {
    return {
      reusable: false,
      reason: 'entry key does not match its own recorded fields — cache file was edited',
      changed: [],
    };
  }

  const changed = diffFingerprints(e.fingerprint as RunFingerprint, expected.fingerprint);
  if (changed.length > 0) {
    return {
      reusable: false,
      reason: 'run fingerprint changed — the cached answer was produced by a different configuration',
      changed,
    };
  }

  if (e.outcome.caseId !== expected.caseId || e.outcome.arm !== expected.arm) {
    return {
      reusable: false,
      reason: 'cached outcome does not belong to the case/arm it is filed under',
      changed: [],
    };
  }

  return { reusable: true, outcome: e.outcome as CaseOutcome };
}

/** Build a storable entry. */
export function makeCacheEntry(
  components: CacheKeyComponents,
  outcome: CaseOutcome,
  storedAt: string = new Date().toISOString(),
): CacheEntry {
  return {
    key: cacheKey(components),
    arm: components.arm,
    caseId: components.caseId,
    goldenVersion: components.goldenVersion,
    fingerprint: components.fingerprint,
    fingerprintDigest: fingerprintDigest(components.fingerprint),
    outcome,
    storedAt,
  };
}

/**
 * Entries filed under the same arm/case/golden set but a DIFFERENT fingerprint.
 *
 * These are the interesting ones: their presence means the configuration moved,
 * and reporting them is what turns a silent cache miss into a visible
 * "your config changed, so these N cases are being re-run".
 */
export function staleSiblings(
  file: CacheFile,
  expected: CacheKeyComponents,
): CacheEntry[] {
  const out: CacheEntry[] = [];
  for (const entry of Object.values(file.entries)) {
    if (
      entry &&
      entry.arm === expected.arm &&
      entry.caseId === expected.caseId &&
      entry.goldenVersion === expected.goldenVersion &&
      entry.fingerprintDigest !== fingerprintDigest(expected.fingerprint)
    ) {
      out.push(entry);
    }
  }
  return out;
}

export function emptyCache(): CacheFile {
  return { cacheFormat: CACHE_FORMAT, entries: {} };
}

/** Content digest of a cache file — used in tests to prove a run re-ran. */
export function cacheFileDigest(file: CacheFile): string {
  return sha256(canonicalJson(file)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Persistence (fs)
// ---------------------------------------------------------------------------

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read the cache file. A missing, unreadable, or pre-B3 file yields an empty
 * cache and a loud stderr note — never a silent partial reuse.
 */
export function loadCache(
  cachePath: string | null | undefined,
  warn: (msg: string) => void = (m) => process.stderr.write(m),
): CacheFile {
  if (!cachePath || !fs.existsSync(cachePath)) return emptyCache();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch (err) {
    warn(`[eval] resume cache at ${cachePath} is unreadable (${errText(err)}) — starting fresh.\n`);
    return emptyCache();
  }
  if (!parsed || typeof parsed !== 'object') return emptyCache();

  const file = parsed as Partial<CacheFile>;
  if (file.cacheFormat !== CACHE_FORMAT || typeof file.entries !== 'object' || file.entries === null) {
    warn(
      `[eval] ================================================================\n` +
        `[eval] REFUSING the resume cache at ${cachePath}.\n` +
        `[eval] It is in the pre-B3 format, whose key was ` +
        `\`arm::caseId::goldenVersion\` — it recorded NOTHING about the models, k, ` +
        `seat roster, thresholds, ACCURACY_WEIGHTS or council code that produced it,\n` +
        `[eval] so those outcomes cannot be attributed to the current configuration.\n` +
        `[eval] Every case will be re-run. Delete the file to silence this.\n` +
        `[eval] ================================================================\n`,
    );
    return emptyCache();
  }
  return { cacheFormat: CACHE_FORMAT, entries: file.entries as Record<string, CacheEntry> };
}

export function saveCache(
  cachePath: string | null | undefined,
  cache: CacheFile,
  warn: (msg: string) => void = (m) => process.stderr.write(m),
): void {
  if (!cachePath) return;
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Write-then-rename so an interrupt mid-write cannot corrupt the cache.
    const tmp = `${cachePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, cachePath);
  } catch (err) {
    warn(`[eval] could not write resume cache: ${errText(err)}\n`);
  }
}

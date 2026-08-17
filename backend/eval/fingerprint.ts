/**
 * Run fingerprinting for the resume cache (defect B3).
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * The resume cache is on by default and its key used to be
 *
 *     `${arm}::${caseId}::${goldenVersion}`   e.g. council::soccer-001::soccer@1.0.0
 *
 * which mentions NOTHING that determines the answer: no model slugs, no `k`,
 * no seat roster, no escalation thresholds, no ACCURACY_WEIGHTS, no code
 * version. The default cache path is gitignored, so it survives every code
 * change. Changing the council's answers AND `k`, then re-running without
 * `--no-cache`, produced byte-identical outcomes — the new arm was never
 * invoked. That is the cheapest possible route to a fabricated improvement,
 * and it leaves no trace in the report.
 *
 * ---------------------------------------------------------------------------
 * THE FIX
 * ---------------------------------------------------------------------------
 * The key now carries a digest of a `RunFingerprint` covering every input that
 * can change an answer, and every cache entry records the fingerprint it was
 * produced under. Mismatches are REFUSED and announced loudly on stderr rather
 * than silently re-running or, worse, silently reusing.
 *
 * The council source hash is computed by READING the files, never by importing
 * them: this module must stay importable with no network, no API key, and no
 * side effects, and must keep working while another agent is mid-edit in
 * backend/council/**.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Bump when the SCORING maths changes in a way that makes old cached outcomes
 * incomparable with new ones. Cached CaseOutcomes are scored objects, not raw
 * model responses, so a change in scoreCase() invalidates them.
 */
export const HARNESS_VERSION = 'eval-2';

/** One seat, reduced to the fields that change the answer. */
export interface SeatFingerprint {
  id: string;
  model: string;
  role: string;
  temperature: number;
}

/** Everything that can change an arm's answer to a case. */
export interface RunFingerprint {
  /** Scoring-code version. See HARNESS_VERSION. */
  harnessVersion: string;
  /** Retrieval shortlist size handed to the arm. */
  k: number;
  /** Resolved panel roster, or null when the council module could not be read. */
  seats: SeatFingerprint[] | null;
  /** Resolved chair, or null when unavailable. */
  chair: SeatFingerprint | null;
  /** Escalation cut-points. */
  consensusThreshold: number | null;
  minProbability: number | null;
  quorum: number | null;
  /** The accuracyScore composite weights. */
  accuracyWeights: Record<string, number> | null;
  /** sha256 over the contents of backend/council/**. */
  councilSourceHash: string;
  /**
   * sha256 over the contents of backend/graph/**.
   *
   * The graph arm's answer depends on the auditor prompt, the penalty constants
   * in score.ts and the reconciler ceiling just as much as the council arm's
   * depends on backend/council. Without this, editing the auditor and re-running
   * would serve the pre-edit outcomes straight out of the resume cache and
   * report the change as having had no effect — defect B3 with a new directory.
   */
  graphSourceHash: string;
  /** Resolved graph node roster (observers, reconciler, auditor), or null. */
  graphModels: Record<string, string> | null;
  /**
   * sha256 over every COUNCIL_*-prefixed environment variable (name and value).
   * Hashed rather than stored so nothing that happens to live under that prefix
   * ends up written to a results file. Catches model-slug and threshold
   * overrides even when the resolved config could not be read.
   */
  councilEnvHash: string;
  /** sha256 over every GRAPH_*-prefixed environment variable, name and value. */
  graphEnvHash: string;
  /** True when seats/chair/thresholds/weights could not be resolved. */
  incomplete: boolean;
}

/** Stable JSON: object keys sorted at every level, so the digest is canonical. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Short, human-quotable digest of a fingerprint. Full sha256 is overkill in a log line. */
export function fingerprintDigest(fp: RunFingerprint): string {
  return sha256(canonicalJson(fp)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Council source hash
// ---------------------------------------------------------------------------

/** Default location of the council implementation, relative to the repo root. */
export const COUNCIL_DIR = path.join(process.cwd(), 'backend', 'council');

/** Default location of the graph implementation, relative to the repo root. */
export const GRAPH_DIR = path.join(process.cwd(), 'backend', 'graph');

function walkFiles(dir: string, acc: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    // __tests__ cannot change an answer, and another agent editing council
    // tests should not invalidate a legitimately resumable run.
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walkFiles(full, acc);
    } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs|json)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Content hash of a source directory — backend/council or backend/graph.
 *
 * READS the files; deliberately does not import them. Importing would pull in
 * the OpenRouter client and would fail outright while either module is
 * mid-edit, which is exactly when a stale cache is most dangerous.
 *
 * Paths are hashed relative to `dir` and line endings normalised, so the digest
 * is stable across machines and across a CRLF checkout.
 */
export function hashSourceDir(dir: string): string {
  const files = walkFiles(dir);
  if (files.length === 0) return 'council-source-unreadable';
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      content = '<unreadable>';
    }
    hash.update(path.relative(dir, file).split(path.sep).join('/'));
    hash.update('\0');
    hash.update(content.replace(/\r\n/g, '\n'));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Back-compat alias: the same content hash, defaulted to the council dir. */
export function hashCouncilSource(dir: string = COUNCIL_DIR): string {
  return hashSourceDir(dir);
}

/** Digest of every environment variable under `prefix`. Hashed, never stored. */
export function hashEnvPrefix(
  prefix: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const entries = Object.keys(env)
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => `${key}=${env[key] ?? ''}`);
  return sha256(entries.join('\n'));
}

/** Digest of every COUNCIL_* environment variable. See RunFingerprint.councilEnvHash. */
export function hashCouncilEnv(env: Record<string, string | undefined> = process.env): string {
  return hashEnvPrefix('COUNCIL_', env);
}

/** Digest of every GRAPH_* environment variable. See RunFingerprint.graphEnvHash. */
export function hashGraphEnv(env: Record<string, string | undefined> = process.env): string {
  return hashEnvPrefix('GRAPH_', env);
}

// ---------------------------------------------------------------------------
// Building the fingerprint
// ---------------------------------------------------------------------------

/** The council-side config the fingerprint needs. Shaped so the CLI can pass
 *  through whatever backend/council exports without this module importing it. */
export interface CouncilConfigLike {
  seats?: Array<{ id?: unknown; model?: unknown; role?: unknown; temperature?: unknown }>;
  chair?: { id?: unknown; model?: unknown; role?: unknown; temperature?: unknown };
  consensusThreshold?: unknown;
  minProbability?: unknown;
  quorum?: unknown;
}

function seatOf(raw: CouncilConfigLike['chair']): SeatFingerprint | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: String(raw.id ?? ''),
    model: String(raw.model ?? ''),
    role: String(raw.role ?? ''),
    temperature: Number(raw.temperature ?? 0),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface BuildFingerprintOptions {
  k: number;
  config?: CouncilConfigLike | null;
  accuracyWeights?: Record<string, number> | null;
  councilDir?: string;
  graphDir?: string;
  /** Resolved graph node models, e.g. { auditor: 'mistralai/...' }. */
  graphModels?: Record<string, string> | null;
  env?: Record<string, string | undefined>;
  harnessVersion?: string;
}

/**
 * Assemble the fingerprint.
 *
 * `config` and `accuracyWeights` come from the caller (the CLI resolves them
 * through its existing lazy council import). When they are missing the
 * fingerprint is still built and `incomplete` is set — the source hash and env
 * hash alone already invalidate the cache on any code or override change, so a
 * degraded fingerprint is still safe; it is just less informative, and callers
 * warn about it.
 */
export function buildRunFingerprint(opts: BuildFingerprintOptions): RunFingerprint {
  const config = opts.config ?? null;
  const seats = Array.isArray(config?.seats)
    ? (config?.seats.map(seatOf).filter((s): s is SeatFingerprint => s !== null) ?? null)
    : null;
  const chair = seatOf(config?.chair);
  const weights = opts.accuracyWeights ? { ...opts.accuracyWeights } : null;

  return {
    harnessVersion: opts.harnessVersion ?? HARNESS_VERSION,
    k: opts.k,
    seats,
    chair,
    consensusThreshold: numOrNull(config?.consensusThreshold),
    minProbability: numOrNull(config?.minProbability),
    quorum: numOrNull(config?.quorum),
    accuracyWeights: weights,
    councilSourceHash: hashCouncilSource(opts.councilDir ?? COUNCIL_DIR),
    graphSourceHash: hashSourceDir(opts.graphDir ?? GRAPH_DIR),
    graphModels: opts.graphModels ? { ...opts.graphModels } : null,
    councilEnvHash: hashCouncilEnv(opts.env ?? process.env),
    graphEnvHash: hashGraphEnv(opts.env ?? process.env),
    incomplete: seats === null || chair === null || weights === null,
  };
}

/**
 * Field-by-field diff of two fingerprints, as human-readable lines.
 *
 * Used to explain a cache refusal. "cache miss" on its own teaches the operator
 * nothing; "seats changed, k 5 -> 7" tells them the cache did its job.
 */
export function diffFingerprints(older: RunFingerprint, newer: RunFingerprint): string[] {
  const changed: string[] = [];
  const keys = new Set([...Object.keys(older), ...Object.keys(newer)]) as Set<keyof RunFingerprint>;
  for (const key of [...keys].sort()) {
    const a = canonicalJson(older[key]);
    const b = canonicalJson(newer[key]);
    if (a === b) continue;
    const short = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
    changed.push(`${key}: ${short(a)} -> ${short(b)}`);
  }
  return changed;
}

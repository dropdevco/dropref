import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Per-run artifact writer.
 *
 * Every node writes its output to `backend/runs/<runId>/<node>.json`. That
 * directory IS the state contract made concrete: a verdict can be traced back
 * to the node that introduced the wrong fact, two runs can be diffed, and held
 * cases accumulate into golden-set candidates instead of evaporating with the
 * HTTP response.
 *
 * HARD RULE: writing an artifact must NEVER fail a request. The filesystem is
 * read-only on most serverless deploys, and a verdict the user is waiting for
 * is worth more than its paper trail. Every failure here degrades to a single
 * console warning.
 */

/** Default artifact root, gitignored like backend/eval/results. */
export function runsDir(): string {
  return process.env.GRAPH_RUNS_DIR || path.join(process.cwd(), 'backend', 'runs');
}

/** Artifacts off by default nowhere — but one env var turns them off entirely. */
export function artifactsEnabled(): boolean {
  return !/^(0|false|no|off)$/i.test((process.env.GRAPH_ARTIFACTS ?? '').trim());
}

/**
 * Sortable, collision-resistant run id: base36 millisecond stamp + 4 random
 * bytes. Sortable matters — `ls backend/runs` should read chronologically.
 */
export function newRunId(): string {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** `true` when the artifact was persisted; `false` when it was skipped. */
export function writeArtifact(runId: string, node: string, value: unknown): boolean {
  if (!artifactsEnabled()) return false;
  try {
    const dir = path.join(runsDir(), runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${node}.json`),
      JSON.stringify(value, null, 2),
      'utf8',
    );
    return true;
  } catch (err) {
    console.warn(
      `[Graph] could not write artifact ${runId}/${node}.json: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Queue a run for human review.
 *
 * Separate from the run directory on purpose: the review queue is a WORK LIST
 * that a person drains, and it should be listable without walking every run
 * ever executed.
 */
export function enqueueForReview(runId: string, summary: unknown): boolean {
  if (!artifactsEnabled()) return false;
  try {
    const dir = path.join(runsDir(), 'review-queue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${runId}.json`),
      JSON.stringify(summary, null, 2),
      'utf8',
    );
    return true;
  } catch (err) {
    console.warn(
      `[Graph] could not enqueue ${runId} for review: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/** Read one artifact back. Returns null when absent or unreadable. */
export function readArtifact<T = unknown>(runId: string, node: string): T | null {
  try {
    const file = path.join(runsDir(), runId, `${node}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Run ids present on disk, newest first. */
export function listRuns(): string[] {
  try {
    return fs
      .readdirSync(runsDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'review-queue')
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

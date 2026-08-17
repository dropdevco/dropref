import type { AnalyzeResponse, SportCorpus, SportRule } from '../../types/contract';
import { runCouncil, runSingleModel } from '../council';
import { ruleRef } from '../council/rule-ref';
import type { CouncilInput, CouncilResult } from '../council/types';
import { retrieveRules } from '../rules/retrieve';
import { getSportCorpus } from '../sports';
import { enqueueForReview, newRunId, writeArtifact } from './artifacts';
import { runAudit } from './audit';
import type { GraphConfig } from './models';
import { defaultGraphConfig } from './models';
import { observe } from './observe';
import { composeReliability } from './score';
import type { GraphInput, GraphResult, ObservationBundle } from './types';

/**
 * The analysis graph.
 *
 *   CV pre-pass (in the route) ─┬─> observer A (raw) ────┐
 *                               └─> observer B (CV) ─────┴─> reconciler
 *                                                             │
 *   coarse shortlist (originalCall) ───────────────────────────┴─> retrieval
 *                                                                     │
 *                                     3 seats ─> [debate] ─> [chair] ──┘
 *                                                    │
 *                                        evidence auditor
 *                                                    │
 *                                    score ─> human gate ─> response
 *
 * The two things this adds over calling `runCouncil` directly are the only two
 * things worth adding: the panel's premise is now produced by more than one
 * observer and checked, and the panel's answer is now checked by a node that
 * did not produce it. Everything else here is plumbing and paper trail.
 */

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

/**
 * Shortlist from the referee's call alone.
 *
 * Runs BEFORE any observation exists, because it does not depend on one: the
 * call names the offence. Waiting for the observers to finish before asking
 * "which rules could possibly govern an offside decision" would be pure
 * serialisation of independent work.
 */
export function coarseShortlist(
  corpus: SportCorpus,
  originalCall: string | null,
  k: number,
): SportRule[] {
  if (!originalCall || originalCall.trim() === '') return [];
  return resolveRules(corpus, retrieveRules(corpus, originalCall, k));
}

/** Map retrieval output back to full `SportRule`s BY REF, never by bare code. */
function resolveRules(
  corpus: SportCorpus,
  cited: { code: string; title: string }[],
): SportRule[] {
  const byRef = new Map(corpus.rules.map((r) => [ruleRef(r), r]));
  const out: SportRule[] = [];
  for (const c of cited) {
    const rule = byRef.get(ruleRef({ code: c.code, title: c.title }));
    if (rule) out.push(rule);
  }
  return out;
}

/**
 * Final candidate set: the observation-driven shortlist, then anything the
 * coarse pass found that it missed, capped at `k`.
 *
 * Order matters — the observation shortlist leads, because a description of
 * what actually happened is better evidence of the governing rule than the
 * label the referee put on it. The coarse pass is a safety net for the case
 * where the observers described the play without using the vocabulary the
 * corpus is keyed on.
 */
export function mergeShortlists(
  primary: SportRule[],
  fallback: SportRule[],
  k: number,
): SportRule[] {
  const seen = new Set<string>();
  const merged: SportRule[] = [];
  for (const rule of [...primary, ...fallback]) {
    const ref = ruleRef(rule);
    if (seen.has(ref)) continue;
    seen.add(ref);
    merged.push(rule);
    if (merged.length >= k) break;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* Adjudication                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run the council, degrading to a single model if it cannot reach quorum.
 *
 * A quorum failure is a provider outage, not a verdict. Returning nothing would
 * turn a bad afternoon at OpenRouter into a broken product; returning a
 * single-model answer with the gate open is honest and still useful.
 */
async function adjudicate(input: CouncilInput): Promise<{
  result: CouncilResult;
  degraded: boolean;
}> {
  try {
    return { result: await runCouncil(input), degraded: false };
  } catch (err) {
    console.warn(
      `[Graph] council could not reach quorum, falling back to a single model: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { result: await runSingleModel(input), degraded: true };
  }
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function runAnalysisGraph(
  input: GraphInput,
  config: GraphConfig = defaultGraphConfig(),
): Promise<AnalyzeResponse> {
  const result = await runGraph(input, config);
  return toAnalyzeResponse(result);
}

/** The full state, for the eval harness and for anything that wants the detail. */
export async function runGraph(
  input: GraphInput,
  config: GraphConfig = defaultGraphConfig(),
): Promise<GraphResult> {
  const started = Date.now();
  const runId = newRunId();
  const corpus = getSportCorpus(input.sport);

  writeArtifact(runId, 'input', {
    sport: input.sport,
    originalCall: input.originalCall,
    videoMimeType: input.videoMimeType,
    hasAnnotatedVideo: Boolean(input.annotatedVideoBase64),
    hasSkeleton: Boolean(input.skeletonBase64),
    keyFrameCount: input.keyFramesBase64?.length ?? 0,
    cvMetadata: input.cvMetadata ?? null,
    config,
  });

  /* ---- Coarse shortlist: independent of the observers, so it does not wait ---- */
  const coarse = coarseShortlist(corpus, input.originalCall, config.k);
  writeArtifact(runId, 'shortlist.coarse', coarse.map((r) => ruleRef(r)));

  /* ---- Observation ---- */
  const observeController = new AbortController();
  const observeDeadline = setTimeout(
    () => observeController.abort(),
    config.observeTimeoutMs,
  );
  let observation;
  try {
    observation = await observe(input, corpus, config, observeController.signal);
  } finally {
    clearTimeout(observeDeadline);
  }
  writeArtifact(runId, 'observation', observation);

  /* ---- Retrieval ---- */
  const query = input.originalCall
    ? `${input.originalCall} ${observation.observation}`
    : observation.observation;
  const primary = resolveRules(corpus, retrieveRules(corpus, query, config.k));
  const candidates = mergeShortlists(primary, coarse, config.k);
  writeArtifact(runId, 'shortlist', candidates.map((r) => ruleRef(r)));

  /* ---- Council ---- */
  const councilInput: CouncilInput = {
    sport: input.sport,
    displayName: corpus.displayName,
    observation: observation.observation,
    originalCall: input.originalCall,
    candidates,
    contested: observation.contested,
  };
  const { result: council, degraded } = await adjudicate(councilInput);
  writeArtifact(runId, 'council', council);

  /* ---- Audit ---- */
  const audit = await runAudit(observation, council, candidates, corpus.displayName, config);
  writeArtifact(runId, 'audit', audit);

  /* ---- Score + gate ---- */
  const score = composeReliability(council.accuracyScore, observation, audit);
  if (degraded) {
    score.gateReasons.push('the council could not reach quorum; one model answered alone');
    score.needsHumanReview = true;
  }
  writeArtifact(runId, 'verdict', score);

  const result: GraphResult = {
    runId,
    sport: input.sport,
    verdict: council.verdict,
    confidence: council.confidence,
    observation,
    council,
    audit,
    score,
    reasoning: council.reasoning,
    rulesCited: council.rulesCited,
    agreement: council.agreement,
    originalCall: input.originalCall,
    totalCalls: observation.totalCalls + council.totalCalls + audit.calls,
    processingMs: Date.now() - started,
  };

  if (score.needsHumanReview) {
    enqueueForReview(runId, {
      runId,
      sport: input.sport,
      verdict: council.verdict,
      originalCall: input.originalCall,
      gateReasons: score.gateReasons,
      reliabilityScore: score.reliabilityScore,
      contested: observation.contested,
      unsupportedClaims: audit.unsupportedClaims,
      ruleMisuse: audit.ruleMisuse,
      observation: observation.observation,
      reasoning: council.reasoning,
      queuedMs: result.processingMs,
    });
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Eval arm                                                            */
/* ------------------------------------------------------------------ */

/**
 * The graph, entered BELOW the observer nodes, as a drop-in `Arm` for the eval
 * harness: council -> auditor -> reliability composition.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT. A golden case supplies one
 * hand-written observation string and no clip, so there is nothing for the
 * observers to fan out over and `observationAgreement` is `null` — which makes
 * `observationFactor` exactly 1. This arm therefore isolates the AUDITOR's
 * contribution against the council arm and says nothing at all about the
 * observer fan-out or the reconciler.
 *
 * That is a real limitation, stated here rather than buried: measuring the
 * observation stage needs a clip-backed golden set, which does not exist yet.
 * Until it does, the fan-out is evidenced only by the observer-disagreement
 * rate recorded in the run artifacts.
 */
export async function graphArm(
  input: CouncilInput,
  config: GraphConfig = defaultGraphConfig(),
): Promise<CouncilResult> {
  const started = Date.now();

  const observation: ObservationBundle = {
    observation: input.observation,
    contested: input.contested ?? [],
    // Not measured: one supplied observation, no observers ran. See above.
    observationAgreement: null,
    observers: [],
    reconciled: false,
    failedNodes: [],
    totalCalls: 0,
    processingMs: 0,
  };

  const { result: council, degraded } = await adjudicate(input);
  const audit = await runAudit(
    observation,
    council,
    input.candidates,
    input.displayName,
    config,
  );
  const score = composeReliability(council.accuracyScore, observation, audit);

  // The harness reads `accuracyScore` as the arm's claimed probability, so the
  // graph arm must report the number it actually stands behind — the composed
  // one. Reporting the council's pre-audit score here would have measured the
  // council twice under two names.
  return {
    ...council,
    accuracyScore: score.reliabilityScore,
    reliability: score.reliability,
    totalCalls: council.totalCalls + audit.calls + (degraded ? 1 : 0),
    processingMs: Date.now() - started,
  };
}

/**
 * Project the run onto the frozen `AnalyzeResponse`.
 *
 * `types/contract.ts` is shared and frozen, so everything the graph adds is an
 * OPTIONAL field: an older client that knows nothing about `needsHumanReview`
 * renders exactly what it rendered before rather than breaking.
 */
export function toAnalyzeResponse(result: GraphResult): AnalyzeResponse {
  return {
    sport: result.sport,
    verdict: result.verdict,
    confidence: result.confidence,
    playDescription: result.observation.observation,
    reasoning: result.reasoning,
    rulesCited: result.rulesCited,
    originalCall: result.originalCall,
    processingMs: result.processingMs,

    runId: result.runId,
    reliability: result.score.reliability,
    reliabilityScore: result.score.reliabilityScore,
    accuracyScore: result.score.accuracyScore,
    needsHumanReview: result.score.needsHumanReview,
    reviewReasons: result.score.gateReasons,
    contested: result.observation.contested,
    stage: result.council.stage,
    panel: result.council.opinions.map((o) => ({
      role: o.role,
      verdict: o.verdict,
      confidence: o.confidence,
    })),
  };
}

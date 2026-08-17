import { z } from 'zod';
import type { SportCorpus } from '../../types/contract';
import { buildObservationPrompt } from '../ai/prompts';
import { observePlay } from '../ai/vision';
import { clamp01 } from '../council/agreement';
import { councilChatJson } from '../council/client';
import { coerceProbability } from '../council/panel';
import type { GraphConfig } from './models';
import { pseudoSeat } from './models';
import type {
  GraphInput,
  ObservationBundle,
  ObserverLens,
  ObserverReport,
} from './types';

/**
 * The observation stage: two observers, then a reconciler.
 *
 * WHY THIS EXISTS. Every council seat used to read the same single Stage-1
 * description. Diversity was applied to the JUDGEMENT and none at all to the
 * EVIDENCE — so three differently-lensed seats could agree unanimously, skip
 * the debate round, and report TRUSTWORTHY on a play the one vision call had
 * misdescribed. Agreement downstream of a shared premise measures nothing about
 * the premise.
 *
 * The two observers differ in what they are SHOWN: A gets the original footage
 * with no computer-vision hints at all, B gets the annotated render, the
 * skeleton overlay, the contact-moment keyframes and the CV telemetry. Anything
 * only one of them reports is `contested`, and the council is told so.
 */

/* ------------------------------------------------------------------ */
/* Observers                                                           */
/* ------------------------------------------------------------------ */

const LENS_FRAMING: Record<ObserverLens, string> = {
  raw: `You are watching the ORIGINAL broadcast footage with no annotations of any kind.
Describe only what the unmodified video shows. You have no tracking data and must not pretend to.`,

  annotated: `You are watching a COMPUTER-VISION PROCESSED version of the play: bounding boxes and skeletal
tracking are drawn on the players, and you are additionally given high-resolution stills captured at the
moments of contact. Use the overlays and stills to be PRECISE about limb positions, contact points and
timing. Where the overlays disagree with your first impression of the motion, trust the overlays.`,
};

async function runObserver(
  observerId: string,
  lens: ObserverLens,
  model: string,
  prompt: string,
  video: string,
  input: GraphInput,
  signal: AbortSignal,
): Promise<ObserverReport> {
  const started = Date.now();
  try {
    const description = await observePlay({
      prompt,
      videoBase64: video,
      videoMimeType: input.videoMimeType,
      // Only the annotated observer receives the CV evidence.
      skeletonBase64: lens === 'annotated' ? input.skeletonBase64 : null,
      keyFramesBase64: lens === 'annotated' ? input.keyFramesBase64 : null,
      model,
      signal,
    });
    const text = description.trim();
    if (text === '') throw new Error('observer returned an empty description');
    return { observerId, model, lens, description: text, latencyMs: Date.now() - started };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Graph] observer ${observerId} failed: ${message}`);
    return {
      observerId,
      model,
      lens,
      description: '',
      error: message,
      latencyMs: Date.now() - started,
    };
  }
}

/** True when the CV pre-pass produced evidence worth a second, distinct read. */
export function hasCvEvidence(input: GraphInput): boolean {
  return Boolean(
    input.annotatedVideoBase64 ||
      input.skeletonBase64 ||
      (input.keyFramesBase64 && input.keyFramesBase64.length > 0),
  );
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

export const ReconcilerResponseSchema = z.object({
  agreed: z.string().min(1),
  contested: z.array(z.string()).nullish(),
  agreementScore: z.union([z.number(), z.string()]).nullish(),
});

/**
 * Ceiling on `observationAgreement` implied by the number of contested facts.
 *
 * The reconciler may be MORE pessimistic than this and never more optimistic —
 * the same guard as `capConfidence` in the council. A node that both lists the
 * disagreements and grades their severity can otherwise wave its own findings
 * away in prose. Each contested fact costs 0.15, so four of them floor the
 * agreement at 0.40 however relaxed the summary sounded.
 */
export function contestedCeiling(contestedCount: number): number {
  return Math.max(0, 1 - 0.15 * contestedCount);
}

function buildReconcilerPrompt(
  corpus: SportCorpus,
  a: ObserverReport,
  b: ObserverReport,
): { system: string; user: string } {
  return {
    system: `You reconcile two independent visual accounts of the same ${corpus.displayName} play.

Both observers watched the SAME clip through different evidence: one saw the original footage, the other
saw a computer-vision annotated render plus contact-moment stills. They are not ranked. Neither of them is
the ground truth.

Your job is to separate what BOTH accounts support from what only ONE of them asserts.
- "agreed" contains ONLY details both accounts support, in the same neutral, rule-free style as the
  inputs. Never introduce a detail that appears in neither. Never judge the call and never mention rules.
- "contested" is one short line per factual disagreement: a detail one account asserts and the other
  contradicts, OR a decisive detail only one account mentions at all. Phrase each as the open question it
  is, for example: whether the defender touched the ball before making contact.
- Wording differences are NOT disagreements. Two descriptions of the same tackle in different words agree.
  Contest only facts that cannot both be true, or a load-bearing fact only one observer saw.
- If the accounts describe the same play consistently, "contested" is an empty array. Do not manufacture
  disagreement to look thorough.`,
    user: `OBSERVER A (original footage):
${a.description}

OBSERVER B (computer-vision annotated footage + contact stills):
${b.description}

Return ONLY this JSON object:
{
  "agreed": "3-6 sentences describing only what both accounts support",
  "contested": ["one line per genuine factual disagreement"],
  "agreementScore": 0.0
}

"agreementScore" is your honest 0..1 estimate of how much the two accounts agree about the facts that
would decide whether an offence occurred. 1.0 means they describe the same play; 0.0 means they describe
incompatible events.`,
  };
}

/* ------------------------------------------------------------------ */
/* Stage entry point                                                   */
/* ------------------------------------------------------------------ */

/**
 * Run the observation stage.
 *
 * Degradation, in order of severity:
 *  - no CV evidence        -> one observer, no reconciler, agreement `null`
 *  - one observer errors   -> the survivor's account, agreement `null`
 *  - the reconciler errors -> observer A's account, agreement `null`, and
 *                             'reconciler' recorded in `failedNodes` so the
 *                             human gate can fire on an unchecked premise
 *  - both observers error  -> throws; there is nothing to adjudicate
 *
 * `null` agreement always means "not measured", never "measured as zero". A run
 * is never penalised for evidence it was never given — see `observationFactor`.
 */
export async function observe(
  input: GraphInput,
  corpus: SportCorpus,
  config: GraphConfig,
  signal: AbortSignal,
): Promise<ObservationBundle> {
  const started = Date.now();
  const failedNodes: string[] = [];
  let totalCalls = 0;

  const basePrompt = (cv: unknown, lens: ObserverLens): string =>
    `${buildObservationPrompt(corpus, input.originalCall, cv)}\n\n${LENS_FRAMING[lens]}`;

  const runB = config.enabled && hasCvEvidence(input);

  const jobs: Promise<ObserverReport>[] = [
    runObserver(
      'observer-a',
      'raw',
      config.observerA,
      basePrompt(null, 'raw'),
      input.videoBase64,
      input,
      signal,
    ),
  ];
  if (runB) {
    jobs.push(
      runObserver(
        'observer-b',
        'annotated',
        config.observerB,
        basePrompt(input.cvMetadata, 'annotated'),
        input.annotatedVideoBase64 ?? input.videoBase64,
        input,
        signal,
      ),
    );
  }

  const observers = await Promise.all(jobs);
  totalCalls += observers.length;
  for (const o of observers) if (o.error) failedNodes.push(o.observerId);

  const usable = observers.filter((o) => !o.error && o.description !== '');
  if (usable.length === 0) {
    throw new Error(
      `Observation failed: ${observers
        .map((o) => `${o.observerId} (${o.error ?? 'empty'})`)
        .join('; ')}`,
    );
  }

  const single = (): ObservationBundle => ({
    observation: usable[0].description,
    contested: [],
    observationAgreement: null,
    observers,
    reconciled: false,
    failedNodes,
    totalCalls,
    processingMs: Date.now() - started,
  });

  if (usable.length < 2) return single();

  /* ---- Reconcile ---- */
  const [a, b] = usable;
  const { system, user } = buildReconcilerPrompt(corpus, a, b);
  try {
    const { value, calls } = await councilChatJson(
      {
        seat: pseudoSeat('reconciler', config.reconciler, 0.1),
        system,
        user,
        signal,
        maxTokens: 1200,
      },
      ReconcilerResponseSchema,
    );
    totalCalls += calls;

    const contested = (value.contested ?? []).map((c) => c.trim()).filter((c) => c !== '');
    const claimed = coerceProbability(value.agreementScore);
    const ceiling = contestedCeiling(contested.length);
    const agreement = Math.min(claimed === null ? ceiling : clamp01(claimed), ceiling);

    return {
      observation: value.agreed.trim(),
      contested,
      observationAgreement: agreement,
      observers,
      reconciled: true,
      failedNodes,
      totalCalls,
      processingMs: Date.now() - started,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Graph] reconciler failed, falling back to observer A: ${message}`);
    totalCalls += 1;
    failedNodes.push('reconciler');
    return single();
  }
}

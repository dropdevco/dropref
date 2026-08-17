import type { CouncilSeat } from '../council/types';
import { getOpenRouterModel } from '../ai/vision';

/**
 * Model roster and budgets for the nodes the graph adds around the council.
 *
 * Every slug is env-overridable, following backend/council/models.ts. The
 * defaults are deliberately cheap: the council's escalation stages are the
 * expensive part of a run and the nodes here must not compete with them for
 * budget.
 */

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

const DEFAULT_RECONCILER_MODEL = 'google/gemini-2.5-flash';

/**
 * The auditor must not be a model that produced the answer it is grading.
 *
 * The default panel is gemini-flash / gpt-4o-mini / claude-haiku and the chair
 * is claude-opus, so the auditor defaults to a fourth family. If you override
 * the roster, override this too — an auditor sharing a model with the lead seat
 * is a self-grading node wearing a different hat, which is the exact failure
 * this node exists to remove.
 */
const DEFAULT_AUDITOR_MODEL = 'mistralai/mistral-small-3.2-24b-instruct';

/** Vision model for the raw-clip observer. Defaults to the existing pipeline's. */
export function observerAModel(): string {
  return envStr('GRAPH_OBSERVER_A_MODEL', getOpenRouterModel());
}

/**
 * Vision model for the CV-annotated observer.
 *
 * Defaults to the SAME slug as observer A, and that is honest rather than lazy:
 * few models on this account accept video, so the diversity that is actually
 * available at the observation stage is diversity of EVIDENCE — raw footage
 * versus skeleton overlay plus contact-moment keyframes — not of weights. Point
 * this at a second video-capable slug when you have one and the fan-out gets
 * strictly stronger.
 */
export function observerBModel(): string {
  return envStr('GRAPH_OBSERVER_B_MODEL', observerAModel());
}

export function reconcilerModel(): string {
  return envStr('GRAPH_RECONCILER_MODEL', DEFAULT_RECONCILER_MODEL);
}

export function auditorModel(): string {
  return envStr('GRAPH_AUDITOR_MODEL', DEFAULT_AUDITOR_MODEL);
}

/** Whole observation stage (both observers + reconciler). */
export const DEFAULT_OBSERVE_TIMEOUT_MS = 60_000;
/** The auditor runs on its own deadline, like the chair. */
export const DEFAULT_AUDIT_TIMEOUT_MS = 20_000;

export interface GraphConfig {
  observerA: string;
  observerB: string;
  reconciler: string;
  auditor: string;
  observeTimeoutMs: number;
  auditTimeoutMs: number;
  /** When false, the graph runs one observer and skips the auditor. */
  enabled: boolean;
  /** Retrieval shortlist size. Matches backend/ai/pipeline.ts. */
  k: number;
}

export function defaultGraphConfig(overrides: Partial<GraphConfig> = {}): GraphConfig {
  return {
    observerA: observerAModel(),
    observerB: observerBModel(),
    reconciler: reconcilerModel(),
    auditor: auditorModel(),
    observeTimeoutMs: envNum('GRAPH_OBSERVE_TIMEOUT_MS', DEFAULT_OBSERVE_TIMEOUT_MS),
    auditTimeoutMs: envNum('GRAPH_AUDIT_TIMEOUT_MS', DEFAULT_AUDIT_TIMEOUT_MS),
    enabled: envBool('GRAPH_ENABLED', true),
    k: envNum('GRAPH_K', 5),
    ...overrides,
  };
}

/**
 * `councilChatJson` is keyed on a `CouncilSeat`, and the reconciler and auditor
 * are chat-JSON calls with the same retry, fallback-ladder and abort semantics.
 * Rather than write a second client, they borrow the seat shape. Only `id`,
 * `model` and `temperature` are read by the transport; `role` never reaches the
 * wire because these nodes supply their own system prompts.
 */
export function pseudoSeat(id: string, model: string, temperature: number): CouncilSeat {
  return { id, model, role: 'skeptic', temperature };
}

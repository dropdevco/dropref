import type { z } from 'zod';
import { fallbackModel } from './models';
import type { CouncilSeat } from './types';

/**
 * OpenRouter wrapper for a single council seat.
 *
 * Request shape, auth headers and error handling follow `backend/ai/pipeline.ts`
 * (`openRouterChat`), which is the shape already proven against this account.
 * The additions here are per-seat model + temperature, a system/user message
 * split (the role framing must not be buried in the user turn), an external
 * AbortSignal so the whole council honours one deadline, and the
 * model-fallback ladder from `lib/lab/adjudicate.ts`.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export class CouncilCallError extends Error {
  readonly seatId: string;
  readonly model: string;
  constructor(seatId: string, model: string, message: string) {
    super(message);
    this.name = 'CouncilCallError';
    this.seatId = seatId;
    this.model = model;
  }
}

/**
 * Errors that are specific to a model/endpoint rather than to our request —
 * bad slug, no credits, per-model rate cap. Same predicate as
 * `lib/lab/adjudicate.ts#isRetryableModelError`; worth trying the next model.
 */
export function isRetryableModelError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b400\b|\b402\b|\b404\b|\b429\b|\b5\d\d\b|not found|no endpoints|not supported|no longer available|quota|rate limit|insufficient|overloaded/i.test(
    m,
  );
}

/** An abort from our own deadline must never be retried onto another model. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  return err instanceof Error && /abort/i.test(err.message);
}

/** Parse JSON that may arrive fenced or wrapped in prose. Mirrors both callers. */
export function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through to brace scan */
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new Error('Model did not return valid JSON.');
}

export interface CouncilChatArgs {
  seat: CouncilSeat;
  system: string;
  user: string;
  /** Council-wide deadline. */
  signal: AbortSignal;
  maxTokens?: number;
}

async function postOnce(
  model: string,
  args: CouncilChatArgs,
  key: string,
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': 'RefCheck AI Council',
    },
    body: JSON.stringify({
      model,
      temperature: args.seat.temperature,
      max_tokens: args.maxTokens ?? 900,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
    }),
    signal: args.signal,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      `OpenRouter returned no content${data.error?.message ? ': ' + data.error.message : ''}`,
    );
  }
  return content;
}

export interface CouncilChatResult {
  text: string;
  /** The model that actually answered — may be the fallback, not `seat.model`. */
  model: string;
  latencyMs: number;
}

/**
 * One seat, one turn. Tries the seat's own model, then the shared fallback if
 * (and only if) the failure was model-specific. Aborts propagate immediately.
 */
export async function councilChat(
  args: CouncilChatArgs,
): Promise<CouncilChatResult> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new CouncilCallError(
      args.seat.id,
      args.seat.model,
      'OPENROUTER_API_KEY is not set.',
    );
  }

  const fallback = fallbackModel();
  const ladder =
    fallback && fallback !== args.seat.model
      ? [args.seat.model, fallback]
      : [args.seat.model];

  const started = Date.now();
  let lastErr: unknown;
  for (const model of ladder) {
    if (args.signal.aborted) break;
    try {
      const text = await postOnce(model, args, key);
      return { text, model, latencyMs: Date.now() - started };
    } catch (err) {
      lastErr = err;
      if (isAbortError(err) || !isRetryableModelError(err)) break;
    }
  }

  const reason = args.signal.aborted
    ? 'council deadline exceeded'
    : lastErr instanceof Error
      ? lastErr.message
      : String(lastErr);
  throw new CouncilCallError(
    args.seat.id,
    args.seat.model,
    `seat ${args.seat.id} (${ladder.join(' -> ')}) failed: ${reason}`,
  );
}

/**
 * Call a seat and validate the reply against a zod schema, retrying the seat
 * ONCE on a parse/validation failure. The retry appends a corrective nudge
 * rather than resending the identical prompt — an identical resend to a
 * near-deterministic seat usually reproduces the same malformed output.
 */
export async function councilChatJson<T>(
  args: CouncilChatArgs,
  schema: z.ZodType<T>,
): Promise<{ value: T; model: string; latencyMs: number; calls: number }> {
  let lastErr: unknown;
  const started = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (args.signal.aborted) break;
    const user =
      attempt === 0
        ? args.user
        : `${args.user}\n\nYour previous reply could not be parsed (${
            lastErr instanceof Error ? lastErr.message : 'invalid JSON'
          }). Reply again with ONLY the JSON object, no prose, no code fences, and every required field present.`;
    try {
      const res = await councilChat({ ...args, user });
      return {
        value: schema.parse(extractJson(res.text)),
        model: res.model,
        latencyMs: Date.now() - started,
        calls: attempt + 1,
      };
    } catch (err) {
      lastErr = err;
      // A transport failure already exhausted its own ladder inside
      // councilChat; only malformed OUTPUT is worth a second prompt.
      if (err instanceof CouncilCallError || isAbortError(err)) break;
    }
  }

  throw new CouncilCallError(
    args.seat.id,
    args.seat.model,
    lastErr instanceof Error ? lastErr.message : String(lastErr),
  );
}

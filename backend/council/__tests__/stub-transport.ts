/**
 * Offline fake transport for the council tests.
 *
 * Installs a `globalThis.fetch` that NEVER touches the network: every request
 * is parsed, recorded, classified by council stage, and answered from a script
 * keyed by model slug. Only a dummy OPENROUTER_API_KEY is needed and no request
 * can escape the process.
 *
 * Recording the request bodies is half the point: the anti-brand-deference and
 * self-exclusion properties are properties OF THE PROMPT, so the tests assert
 * against `calls[i].prompt` rather than against a return value.
 */

/** Which council stage a captured request belongs to, inferred from the prompt. */
export type Stage = 'panel' | 'debate' | 'chair';

export interface StubCall {
  index: number;
  url: string;
  /** The slug actually routed to - may be the fallback, not the seat's model. */
  model: string;
  temperature: number;
  maxTokens: number;
  system: string;
  user: string;
  /** system + user concatenated; what the seat actually reads. */
  prompt: string;
  stage: Stage;
}

/**
 * One scripted answer.
 *  - `json`         -> HTTP 200 whose message content is JSON.stringify(json)
 *  - `text`         -> HTTP 200 with arbitrary (possibly unparseable) content
 *  - `httpStatus`   -> a non-ok HTTP response
 *  - `networkError` -> the fetch promise rejects
 */
export type StubReply =
  | { json: unknown }
  | { text: string }
  | { httpStatus: number; body?: string }
  | { networkError: string };

export interface SeatScript {
  panel?: StubReply | StubReply[];
  debate?: StubReply | StubReply[];
  chair?: StubReply | StubReply[];
}

/** Script keyed by model slug; each stage's replies are consumed in order. */
export type StubScript = Record<string, SeatScript>;

export interface StubTransport {
  /** Every request that reached the transport, in call order. */
  calls: StubCall[];
  /** Requests that had no scripted reply left - always assert this is empty. */
  unscripted: string[];
  fetchCount(): number;
  stage(stage: Stage): StubCall[];
  prompts(...stages: Stage[]): string[];
  restore(): void;
}

/**
 * Classify by prompt content rather than by call order: order is exactly what
 * the escalation mutations change, so it cannot be used to label the stages.
 */
function detectStage(user: string): Stage {
  if (user.includes('The council remained split.')) return 'chair';
  if (user.includes('YOUR FIRST-ROUND OPINION:')) return 'debate';
  return 'panel';
}

function toQueue(entry: StubReply | StubReply[] | undefined): StubReply[] {
  if (!entry) return [];
  return Array.isArray(entry) ? [...entry] : [entry];
}

function okResponse(content: string): Response {
  const payload = { choices: [{ message: { content } }] };
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: { message: body } }),
    text: async () => body,
  } as unknown as Response;
}

interface RequestInitLike {
  body?: unknown;
  signal?: AbortSignal;
}

interface ChatBody {
  model?: unknown;
  temperature?: unknown;
  max_tokens?: unknown;
  messages?: { role?: unknown; content?: unknown }[];
}

function messageContent(body: ChatBody, role: string): string {
  const hit = (body.messages ?? []).find((m) => m.role === role);
  return typeof hit?.content === 'string' ? hit.content : '';
}

/**
 * Replace `globalThis.fetch` for the duration of one scenario. ALWAYS call
 * `restore()` in a finally block.
 */
export function installStubTransport(script: StubScript): StubTransport {
  const realFetch = globalThis.fetch;
  const calls: StubCall[] = [];
  const unscripted: string[] = [];
  const queues = new Map<string, StubReply[]>();

  for (const [model, seat] of Object.entries(script)) {
    queues.set(`${model}::panel`, toQueue(seat.panel));
    queues.set(`${model}::debate`, toQueue(seat.debate));
    queues.set(`${model}::chair`, toQueue(seat.chair));
  }

  const stubFetch = async (
    input: unknown,
    init?: RequestInitLike,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : String((input as { url?: unknown })?.url ?? input);
    const body = JSON.parse(String(init?.body ?? '{}')) as ChatBody;
    const system = messageContent(body, 'system');
    const user = messageContent(body, 'user');
    const model = String(body.model ?? '');
    const stage = detectStage(user);

    calls.push({
      index: calls.length,
      url,
      model,
      temperature: Number(body.temperature),
      maxTokens: Number(body.max_tokens),
      system,
      user,
      prompt: `${system}\n${user}`,
      stage,
    });

    if (init?.signal?.aborted) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      throw err;
    }

    const queue = queues.get(`${model}::${stage}`);
    const reply = queue?.shift();
    if (!reply) {
      unscripted.push(`${stage} call to ${model || '(no model)'}`);
      throw new Error(
        `stub-transport: no scripted ${stage} reply left for model "${model}"`,
      );
    }

    if ('networkError' in reply) throw new Error(reply.networkError);
    if ('httpStatus' in reply) {
      return errorResponse(reply.httpStatus, reply.body ?? 'stubbed failure');
    }
    if ('text' in reply) return okResponse(reply.text);
    return okResponse(JSON.stringify(reply.json));
  };

  globalThis.fetch = stubFetch as unknown as typeof fetch;

  return {
    calls,
    unscripted,
    fetchCount: () => calls.length,
    stage: (stage) => calls.filter((c) => c.stage === stage),
    prompts: (...stages) =>
      calls.filter((c) => stages.includes(c.stage)).map((c) => c.prompt),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Timer + warning tracking                                            */
/* ------------------------------------------------------------------ */

export interface TimerTracker {
  live(): number;
  reset(): void;
  restore(): void;
}

/**
 * Count outstanding `setTimeout` handles so a scenario can assert the council
 * cleared its deadline. Created timers are unref'd, so a genuine leak shows up
 * as a failed assertion instead of a hung test process.
 */
export function trackTimers(): TimerTracker {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const live = new Set<unknown>();

  globalThis.setTimeout = ((
    handler: (...a: unknown[]) => void,
    ms?: number,
    ...rest: unknown[]
  ) => {
    const handle = realSetTimeout(handler, ms, ...rest);
    live.add(handle);
    (handle as unknown as { unref?: () => void }).unref?.();
    return handle;
  }) as unknown as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: unknown) => {
    live.delete(handle);
    return realClearTimeout(handle as Parameters<typeof realClearTimeout>[0]);
  }) as unknown as typeof globalThis.clearTimeout;

  return {
    live: () => live.size,
    reset: () => live.clear(),
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

/** Swallow the council's own `console.warn` chatter, returning what it said. */
export function captureWarnings(): { lines: string[]; restore(): void } {
  const real = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  return {
    lines,
    restore: () => {
      console.warn = real;
    },
  };
}

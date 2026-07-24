import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';

import type {
  CitedRule,
  Confidence,
  SportId,
  SportRule,
  Verdict,
} from '@/types/contract';

/**
 * OWNER: Dev A (frontend) — DEV/TEST TOOL for the Rulebook Lab.
 *
 * Two modes:
 *  - VERDICT mode (a referee call WAS provided): judge whether that call was
 *    correct → FAIR_CALL / BAD_CALL / INCONCLUSIVE (the app's contract shape).
 *  - RULING mode (NO call provided): the AI makes the correct call itself —
 *    e.g. "Direct free kick — foul", "Send off — serious foul play", "Play on" —
 *    with a severity (no-offence / infringement / caution / dismissal). This is
 *    lab-only (the frozen AnalyzeResponse can't express a self-ruling).
 *
 * Provider: OpenRouter (OpenAI-compatible, via fetch — no new dep) when
 * OPENROUTER_API_KEY is set; else the Gemini SDK. Model via OPENROUTER_MODEL /
 * GEMINI_MODEL. Lives under `lib/lab/` (Dev A); never touches Dev B's `lib/ai/**`.
 */

export function isAdjudicationAvailable(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
}

let cachedModel: string | null = null;
export function lastModelUsed(): string | null {
  return cachedModel;
}

export type Severity =
  | 'no-offence'
  | 'infringement'
  | 'caution'
  | 'dismissal';

export interface LabVerdict {
  mode: 'verdict';
  verdict: Verdict;
  confidence: Confidence;
  playDescription: string;
  reasoning: string;
  rulesCited: CitedRule[];
  originalCall: string;
  processingMs: number;
}

export interface LabRuling {
  mode: 'ruling';
  /** The AI's own call, e.g. "Direct free kick — foul" or "Send off". */
  decision: string;
  severity: Severity;
  confidence: Confidence;
  playDescription: string;
  reasoning: string;
  rulesCited: CitedRule[];
  processingMs: number;
}

export type LabResult = LabVerdict | LabRuling;

export interface AdjudicateArgs {
  sport: SportId;
  displayName: string;
  observation: string;
  originalCall: string | null;
  candidates: SportRule[];
}

const verdictSchema = z.object({
  verdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  playDescription: z.string().min(1),
  reasoning: z.string().min(1),
  citedRuleCodes: z.array(z.string()),
});

const rulingSchema = z.object({
  decision: z.string().min(1),
  severity: z.enum(['no-offence', 'infringement', 'caution', 'dismissal']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  playDescription: z.string().min(1),
  reasoning: z.string().min(1),
  citedRuleCodes: z.array(z.string()),
});

function rulesBlock(candidates: SportRule[]): string {
  return candidates.map((r) => `[${r.code}] ${r.title}\n${r.text}`).join('\n\n');
}

function buildVerdictPrompt(args: AdjudicateArgs): string {
  return `You are an expert ${args.displayName} officiating analyst. Decide whether the referee's call was correct, using ONLY the observation and the candidate rules below. Do not invent rules or facts not in the observation.

OBSERVATION (what happened in the clip):
${args.observation}

REFEREE'S CALL ON THE FIELD:
${args.originalCall}

CANDIDATE RULES (a retrieval shortlist; only some will actually apply):
${rulesBlock(args.candidates)}

Return ONLY a JSON object with exactly these fields:
{
  "verdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "playDescription": "1-2 neutral sentences describing what was observed",
  "reasoning": "2-4 sentences explaining the decision and referencing the applicable rule by name",
  "citedRuleCodes": ["<code>"]
}

Rules for your answer:
- verdict FAIR_CALL if the referee's call was correct, BAD_CALL if it was wrong, INCONCLUSIVE if the observation is insufficient to decide.
- citedRuleCodes must be a subset of the candidate codes above — cite ONLY the rule(s) that directly apply (usually exactly one). If none apply, return an empty array and verdict INCONCLUSIVE.
- Use the exact code strings shown in brackets.`;
}

function buildRulingPrompt(args: AdjudicateArgs): string {
  return `You are an expert ${args.displayName} officiating analyst. No referee decision was recorded — YOU must make the correct ruling for this play, using ONLY the observation and the candidate rules below. Do not invent rules or facts not in the observation.

OBSERVATION (what happened in the clip):
${args.observation}

CANDIDATE RULES (a retrieval shortlist; only some will actually apply):
${rulesBlock(args.candidates)}

Return ONLY a JSON object with exactly these fields:
{
  "decision": "the correct call in a few words, e.g. 'Direct free kick — foul', 'Penalty kick', 'Send off — serious foul play', 'No offence — play on', 'Goal disallowed — offside'",
  "severity": "no-offence" | "infringement" | "caution" | "dismissal",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "playDescription": "1-2 neutral sentences describing what was observed",
  "reasoning": "2-4 sentences explaining the ruling and referencing the applicable rule by name",
  "citedRuleCodes": ["<code>"]
}

Severity guide (pick the single most appropriate):
- "no-offence": legal play, nothing to penalise
- "infringement": an offence warranting a restart (free kick, turnover, penalty, disallowed goal…) but no personal caution
- "caution": an offence warranting a formal caution (yellow card or the sport's equivalent)
- "dismissal": a serious offence warranting a sending-off (red card) or the most severe sanction the sport allows

citedRuleCodes must be a subset of the candidate codes above — cite ONLY the rule(s) that directly apply. Use the exact code strings shown in brackets.`;
}

/** Parse JSON that may arrive wrapped in ```fences``` or with surrounding prose. */
function extractJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* fall through */
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      /* fall through */
    }
  }
  throw new Error('Model did not return valid JSON.');
}

/** Errors specific to a model/endpoint (bad id, no credits, rate cap) — try the next candidate. */
function isRetryableModelError(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b400\b|\b402\b|\b404\b|\b429\b|not found|no endpoints|not supported|no longer available|quota|rate limit|insufficient/i.test(
    m,
  );
}

async function openRouterComplete(
  key: string,
  model: string,
  prompt: string,
): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://localhost:3000',
      'X-Title': 'RefCheck AI Rulebook Lab',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    }),
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

async function geminiComplete(
  key: string,
  model: string,
  prompt: string,
): Promise<string> {
  const genAI = new GoogleGenerativeAI(key);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const r = await m.generateContent(prompt);
  return r.response.text();
}

function candidateModels(useOpenRouter: boolean): string[] {
  if (useOpenRouter) {
    // gemini-2.5-flash handles nuanced rules (e.g. "level = onside") better than
    // gpt-4o-mini, which mis-ruled that case; keep the mini as a cheap fallback.
    return process.env.OPENROUTER_MODEL
      ? [process.env.OPENROUTER_MODEL]
      : ['google/gemini-2.5-flash', 'openai/gpt-4o-mini'];
  }
  return process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL]
    : ['gemini-flash-latest', 'gemini-2.0-flash', 'gemini-2.0-flash-001'];
}

/** Send a prompt to the configured provider, trying candidate models in order. */
async function complete(prompt: string): Promise<string> {
  const orKey = process.env.OPENROUTER_API_KEY;
  const gKey = process.env.GEMINI_API_KEY;
  if (!orKey && !gKey) {
    throw new Error(
      'No adjudication key set (OPENROUTER_API_KEY or GEMINI_API_KEY).',
    );
  }
  const useOpenRouter = Boolean(orKey);
  const candidates = candidateModels(useOpenRouter);
  const order =
    cachedModel && candidates.includes(cachedModel)
      ? [cachedModel, ...candidates.filter((m) => m !== cachedModel)]
      : candidates;

  let lastErr: unknown;
  for (const model of order) {
    try {
      const raw = useOpenRouter
        ? await openRouterComplete(orKey as string, model, prompt)
        : await geminiComplete(gKey as string, model, prompt);
      cachedModel = model;
      return raw;
    } catch (err) {
      lastErr = err;
      if (!isRetryableModelError(err)) throw err;
    }
  }
  throw new Error(
    `No usable model (tried ${order.join(', ')}). Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

/** Resolve cited codes to real rule objects, dropping any hallucinated codes. */
function citeRules(codes: string[], candidates: SportRule[]): CitedRule[] {
  const byCode = new Map(candidates.map((r) => [r.code, r]));
  return codes
    .map((c) => byCode.get(c))
    .filter((r): r is SportRule => Boolean(r))
    .map((r) => ({ code: r.code, title: r.title, text: r.text }));
}

/** Run the lab adjudication. Verdict mode if a call was given, else ruling mode. */
export async function adjudicate(args: AdjudicateArgs): Promise<LabResult> {
  const start = Date.now();

  if (args.originalCall) {
    const parsed = verdictSchema.parse(
      extractJson(await complete(buildVerdictPrompt(args))),
    );
    return {
      mode: 'verdict',
      verdict: parsed.verdict,
      confidence: parsed.confidence,
      playDescription: parsed.playDescription,
      reasoning: parsed.reasoning,
      rulesCited: citeRules(parsed.citedRuleCodes, args.candidates),
      originalCall: args.originalCall,
      processingMs: Date.now() - start,
    };
  }

  const parsed = rulingSchema.parse(
    extractJson(await complete(buildRulingPrompt(args))),
  );
  return {
    mode: 'ruling',
    decision: parsed.decision,
    severity: parsed.severity,
    confidence: parsed.confidence,
    playDescription: parsed.playDescription,
    reasoning: parsed.reasoning,
    rulesCited: citeRules(parsed.citedRuleCodes, args.candidates),
    processingMs: Date.now() - start,
  };
}

import { GoogleGenerativeAI } from '@google/generative-ai';

/**
 * Vision transport, extracted verbatim from `pipeline.ts` so the baseline
 * pipeline and the graph's observer nodes share ONE client.
 *
 * Duplicating it would have meant two retry ladders, two key-resolution orders
 * and two places for a provider change to be half-applied — and the whole point
 * of the observer fan-out is that the two observers differ in their EVIDENCE,
 * not in their transport.
 */

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const OPENROUTER_DEFAULT_VIDEO_MODEL = 'google/gemini-2.5-flash';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function generateContentWithRetry(model: any, promptData: any, maxRetries = 3) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await model.generateContent(promptData);
    } catch (e: any) {
      if (e.message?.includes('429') && attempt < maxRetries) {
        attempt++;

        // Gemini often tells us exactly how long to wait (e.g. "Please retry in 25.123s")
        const match = e.message.match(/retry in ([\d\.]+)s/i);
        let waitTime = 10000; // default 10 seconds if parsing fails
        if (match && match[1]) {
          // Add a 1 second buffer to their requested wait time
          waitTime = (parseFloat(match[1]) + 1) * 1000;
        }

        console.warn(`[Gemini API] 429 Rate Limit hit. Retrying attempt ${attempt}/${maxRetries} in ${Math.round(waitTime / 1000)} seconds...`);
        await sleep(waitTime);
      } else {
        throw e;
      }
    }
  }
}

export function getOpenRouterModel(): string {
  return (
    process.env.OPENROUTER_VIDEO_MODEL ||
    process.env.OPENROUTER_MODEL ||
    OPENROUTER_DEFAULT_VIDEO_MODEL
  );
}

export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text;
}

export interface OpenRouterChatArgs {
  prompt: string;
  videoBase64?: string | null;
  videoMimeType?: string;
  skeletonBase64?: string | null;
  keyFramesBase64?: string[] | null;
  json?: boolean;
  /** Overrides `getOpenRouterModel()`. Lets two observers run different slugs. */
  model?: string;
  /** Optional deadline, so the graph can bound the observation stage. */
  signal?: AbortSignal;
  /** See DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
}

/**
 * Cap on the reply.
 *
 * Previously unset, which made OpenRouter reserve its ceiling — 65535 tokens —
 * against the account balance for EVERY vision call, and reject the request
 * outright with a 402 whenever the balance could not cover a reply 50x longer
 * than any this prompt can produce. The observation prompt asks for 3-6
 * sentences and the adjudication prompt for a small JSON object; 1200 is
 * generous for both. The council has always set its own cap for the same
 * reason (see council/client.ts).
 */
export const DEFAULT_MAX_TOKENS = 1200;

export async function openRouterChat({
  prompt,
  videoBase64,
  videoMimeType,
  skeletonBase64,
  keyFramesBase64,
  json = false,
  model,
  signal,
  maxTokens,
}: OpenRouterChatArgs): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }

  const content: any[] = [{ type: 'text', text: prompt }];
  if (videoBase64) {
    const mimeType = videoMimeType || 'video/mp4';
    content.push({
      type: 'video_url',
      videoUrl: {
        url: `data:${mimeType};base64,${videoBase64}`,
      },
    });
  }
  if (skeletonBase64) {
    const mimeType = videoMimeType || 'video/mp4';
    content.push(
      {
        type: 'text',
        text: 'This second video is the optional computer-vision annotated version of the same play.',
      },
      {
        type: 'video_url',
        videoUrl: {
          url: `data:${mimeType};base64,${skeletonBase64}`,
        },
      },
    );
  }
  if (keyFramesBase64 && keyFramesBase64.length > 0) {
    content.push({ type: 'text', text: 'Here are high-resolution still frames captured at the exact moments of physical contact or ball strikes to help you see the details:' });
    keyFramesBase64.forEach(img => {
      content.push({
        type: 'image_url',
        imageUrl: { url: `data:image/jpeg;base64,${img}` }
      });
    });
  }

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:3000',
      'X-Title': 'RefCheck AI',
    },
    body: JSON.stringify({
      model: model || getOpenRouterModel(),
      temperature: json ? 0.2 : 0.3,
      max_tokens: maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    }),
    ...(signal ? { signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    error?: { message?: string };
  };
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error(
      `OpenRouter returned no content${data.error?.message ? ': ' + data.error.message : ''}`,
    );
  }

  return text;
}

export interface ObservePlayArgs {
  prompt: string;
  videoBase64: string;
  videoMimeType: string;
  skeletonBase64: string | null;
  keyFramesBase64?: string[] | null;
  model?: string;
  signal?: AbortSignal;
}

/** One vision call: OpenRouter when a key is present, Gemini direct otherwise. */
export async function observePlay({
  prompt,
  videoBase64,
  videoMimeType,
  skeletonBase64,
  keyFramesBase64,
  model,
  signal,
}: ObservePlayArgs): Promise<string> {

  if (process.env.OPENROUTER_API_KEY) {
    return openRouterChat({
      prompt,
      videoBase64,
      videoMimeType,
      skeletonBase64,
      keyFramesBase64,
      model,
      signal,
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('No AI key set. Add OPENROUTER_API_KEY or GEMINI_API_KEY.');
  }

  const geminiModel = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
  const promptParts: any[] = [
    prompt,
    {
      inlineData: {
        data: videoBase64,
        mimeType: videoMimeType,
      },
    },
  ];

  if (skeletonBase64) {
    promptParts.push({
      inlineData: {
        data: skeletonBase64,
        mimeType: videoMimeType,
      },
    });
  }

  if (keyFramesBase64 && keyFramesBase64.length > 0) {
    promptParts.push('Here are high-resolution still frames captured at the exact moments of physical contact or ball strikes to help you see the details:');
    keyFramesBase64.forEach(img => {
      promptParts.push({
        inlineData: {
          data: img,
          mimeType: 'image/jpeg',
        },
      });
    });
  }

  const obsResult = await generateContentWithRetry(geminiModel, promptParts);
  return obsResult.response.text();
}

/** Text-only adjudication call. Used by the baseline arm. */
export async function adjudicateText(prompt: string): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) {
    return openRouterChat({ prompt, json: true });
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('No AI key set. Add OPENROUTER_API_KEY or GEMINI_API_KEY.');
  }

  const adjModel = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    },
  });
  const adjResult = await generateContentWithRetry(adjModel, [prompt]);
  return adjResult.response.text();
}

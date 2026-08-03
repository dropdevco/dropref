import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { getSportCorpus } from '../sports';
import { retrieveRules, filterValidRuleCodes } from '../rules/retrieve';
import { buildObservationPrompt, buildAdjudicationPrompt } from './prompts';
import { AnalyzeResponse, SportId } from '../../types/contract';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const OPENROUTER_DEFAULT_VIDEO_MODEL = 'google/gemini-2.5-flash';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generateContentWithRetry(model: any, promptData: any, maxRetries = 3) {
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
        
        console.warn(`[Gemini API] 429 Rate Limit hit. Retrying attempt ${attempt}/${maxRetries} in ${Math.round(waitTime/1000)} seconds...`);
        await sleep(waitTime);
      } else {
        throw e;
      }
    }
  }
}

// Zod schema for model output validation
const AdjudicationSchema = z.object({
  verdict: z.enum(['FAIR_CALL', 'BAD_CALL', 'INCONCLUSIVE']),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  reasoning: z.string(),
  ruleCodes: z.array(z.string()),
});

function getOpenRouterModel(): string {
  return (
    process.env.OPENROUTER_VIDEO_MODEL ||
    process.env.OPENROUTER_MODEL ||
    OPENROUTER_DEFAULT_VIDEO_MODEL
  );
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);

  return text;
}

async function openRouterChat({
  prompt,
  videoBase64,
  videoMimeType,
  skeletonBase64,
  keyFramesBase64,
  json = false,
}: {
  prompt: string;
  videoBase64?: string | null;
  videoMimeType?: string;
  skeletonBase64?: string | null;
  keyFramesBase64?: string[] | null;
  json?: boolean;
}): Promise<string> {
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
      model: getOpenRouterModel(),
      temperature: json ? 0.2 : 0.3,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        {
          role: 'user',
          content,
        },
      ],
    }),
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

async function observePlay({
  prompt,
  videoBase64,
  videoMimeType,
  skeletonBase64,
  keyFramesBase64,
}: {
  prompt: string;
  videoBase64: string;
  videoMimeType: string;
  skeletonBase64: string | null;
  keyFramesBase64?: string[] | null;
}): Promise<string> {

  if (process.env.OPENROUTER_API_KEY) {
    return openRouterChat({
      prompt,
      videoBase64,
      videoMimeType,
      skeletonBase64,
      keyFramesBase64,
    });
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('No AI key set. Add OPENROUTER_API_KEY or GEMINI_API_KEY.');
  }

  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });
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

  const obsResult = await generateContentWithRetry(model, promptParts);
  return obsResult.response.text();
}

async function adjudicatePlay(prompt: string): Promise<z.infer<typeof AdjudicationSchema>> {


  if (process.env.OPENROUTER_API_KEY) {
    const text = await openRouterChat({ prompt, json: true });
    return AdjudicationSchema.parse(JSON.parse(extractJson(text)));
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
  return AdjudicationSchema.parse(JSON.parse(extractJson(adjResult.response.text())));
}

export async function runAnalysisPipeline(
  sportId: SportId,
  videoBase64: string,
  videoMimeType: string,
  skeletonBase64: string | null = null,
  originalCall: string | null = null,
  cvMetadata: any = null,
  keyFramesBase64: string[] | null = null
): Promise<AnalyzeResponse> {
  const startTime = Date.now();
  
  // 1. Load corpus
  const corpus = getSportCorpus(sportId);

  // --- STAGE 1: Observation ---
  const obsPrompt = buildObservationPrompt(corpus, originalCall, cvMetadata);
  const playDescription = await observePlay({
    prompt: obsPrompt,
    videoBase64,
    videoMimeType,
    skeletonBase64,
    keyFramesBase64,
  });

  // --- STAGE 2: Adjudication ---
  const searchQuery = originalCall ? `${originalCall} ${playDescription}` : playDescription;
  const retrievedRules = retrieveRules(corpus, searchQuery, 5);
  const adjPrompt = buildAdjudicationPrompt(corpus, playDescription, originalCall, retrievedRules);

  // Try parsing the result, with 1 retry on failure
  let adjudicationData;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      adjudicationData = await adjudicatePlay(adjPrompt);
      break;
    } catch (e) {
      if (attempts === 2) {
        // Fallback on total failure
        adjudicationData = {
          verdict: 'INCONCLUSIVE' as const,
          confidence: 'LOW' as const,
          reasoning: 'Failed to generate a valid response after multiple attempts.',
          ruleCodes: []
        };
      }
    }
  }

  // Filter out any hallucinated rule codes server-side
  const validRuleCodes = filterValidRuleCodes(corpus, adjudicationData!.ruleCodes);
  
  const rulesCited = retrievedRules.filter(r => validRuleCodes.includes(r.code));

  const processingMs = Date.now() - startTime;

  return {
    sport: sportId,
    verdict: adjudicationData!.verdict,
    confidence: adjudicationData!.confidence,
    playDescription,
    reasoning: adjudicationData!.reasoning,
    rulesCited,
    originalCall,
    processingMs
  };
}

import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { getSportCorpus } from '../sports';
import { retrieveRules, filterValidRuleCodes } from '../rules/retrieve';
import { buildObservationPrompt, buildAdjudicationPrompt } from './prompts';
import { AnalyzeResponse, SportId, CitedRule } from '../../types/contract';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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

export async function runAnalysisPipeline(
  sportId: SportId,
  videoBase64: string,
  videoMimeType: string,
  skeletonBase64: string | null = null,
  originalCall: string | null = null,
  cvMetadata: any = null
): Promise<AnalyzeResponse> {
  const startTime = Date.now();
  
  // 1. Load corpus
  const corpus = getSportCorpus(sportId);

  // Use gemini-3.5-flash as it supports video inputs and fast response with higher free tier limits
  const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

  // Convert base64 back to generative part
  const videoPart = {
    inlineData: {
      data: videoBase64,
      mimeType: videoMimeType
    }
  };

  // --- STAGE 1: Observation ---
  const obsPrompt = buildObservationPrompt(corpus, originalCall, cvMetadata);
  const promptParts: any[] = [obsPrompt, videoPart];
  
  if (skeletonBase64) {
    promptParts.push({
      inlineData: {
        data: skeletonBase64,
        mimeType: videoMimeType
      }
    });
  }

  const obsResult = await generateContentWithRetry(model, promptParts);
  const playDescription = obsResult.response.text();

  // --- STAGE 2: Adjudication ---
  const searchQuery = originalCall ? `${originalCall} ${playDescription}` : playDescription;
  const retrievedRules = retrieveRules(corpus, searchQuery, 5);
  const adjPrompt = buildAdjudicationPrompt(corpus, playDescription, originalCall, retrievedRules);

  const adjModel = genAI.getGenerativeModel({
    model: 'gemini-3.5-flash',
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
    }
  });

  // Try parsing the result, with 1 retry on failure
  let adjudicationData;
  let attempts = 0;
  while (attempts < 2) {
    attempts++;
    try {
      const adjResult = await generateContentWithRetry(adjModel, [adjPrompt]);
      const jsonText = adjResult.response.text();
      adjudicationData = AdjudicationSchema.parse(JSON.parse(jsonText));
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

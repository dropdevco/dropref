import { GoogleGenerativeAI } from '@google/generative-ai';
import { z } from 'zod';
import { getSportCorpus } from '../sports';
import { retrieveRules, filterValidRuleCodes } from '../rules/retrieve';
import { buildObservationPrompt, buildAdjudicationPrompt } from './prompts';
import { AnalyzeResponse, SportId, CitedRule } from '../../types/contract';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

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
  originalCall: string | null = null,
  cvMetadata: any = null
): Promise<AnalyzeResponse> {
  const startTime = Date.now();
  
  // 1. Load corpus
  const corpus = getSportCorpus(sportId);

  // Use gemini-flash-latest as it supports video inputs and fast response
  const model = genAI.getGenerativeModel({ model: 'gemini-flash-latest' });

  // Convert base64 back to generative part
  const videoPart = {
    inlineData: {
      data: videoBase64,
      mimeType: videoMimeType
    }
  };

  // --- STAGE 1: Observation ---
  const obsPrompt = buildObservationPrompt(corpus, originalCall, cvMetadata);
  const obsResult = await model.generateContent([obsPrompt, videoPart]);
  const playDescription = obsResult.response.text();

  // --- STAGE 2: Adjudication ---
  const searchQuery = originalCall ? `${originalCall} ${playDescription}` : playDescription;
  const retrievedRules = retrieveRules(corpus, searchQuery, 5);
  const adjPrompt = buildAdjudicationPrompt(corpus, playDescription, originalCall, retrievedRules);

  const adjModel = genAI.getGenerativeModel({
    model: 'gemini-flash-latest',
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
      const adjResult = await adjModel.generateContent([adjPrompt]);
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

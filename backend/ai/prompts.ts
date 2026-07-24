import { SportCorpus, CitedRule } from '../../types/contract';

export function buildObservationPrompt(corpus: SportCorpus, originalCall: string | null, cvMetadata: any = null): string {
  const focusContext = originalCall 
    ? `The original call on the field was: "${originalCall}". Focus your observation strictly on the players, contact, and events relevant to this specific call.`
    : `For this sport specifically, pay attention to: ${corpus.observationHints}`;

  const cvContext = cvMetadata
    ? `\n[COMPUTER VISION SYSTEM DATA]\nThe provided video has been pre-processed. Bounding boxes and skeletal tracking lines have been drawn onto the players. Metadata found: ${JSON.stringify(cvMetadata)}\n\nCRITICAL INSTRUCTION: The 'telemetry' array contains mathematically calculated physics events (e.g. BALL_KICKED, PLAYER_COLLISION). You MUST treat these telemetry events as absolute mathematical facts. Use the exact frame numbers provided in the telemetry to pinpoint when the decisive action occurred in the video.\nPlease cross-reference this hard tracking data with your visual analysis.\n`
    : '';

  return `You are a neutral sports video analyst. Watch this ${corpus.displayName} clip.

Describe ONLY what is physically observable. Do not judge whether any
call was correct. Do not mention rules.

${focusContext}
${cvContext}

Report:
1. The sequence of events, in order
2. Player positions and movement at the decisive moment
3. Body positioning, point of contact, ball or object position
4. Camera limitations — state explicitly what is NOT visible,
   obscured, or off-screen

If the clip is too short, too low quality, or the key moment is not
clearly visible, say so plainly and specifically.

Use precise, standard ${corpus.displayName} terminology when describing
actions (e.g. "reckless slide tackle that trips the opponent before the
ball", not "he slid in and caught the guy's leg"), so the description can
be matched to the written Laws. Do NOT cite rule numbers or judge the call.

Return 3-6 sentences of plain description.`;
}

export function buildAdjudicationPrompt(corpus: SportCorpus, playDescription: string, originalCall: string | null, rules: CitedRule[]): string {
  const retrievedRulesText = rules.map(r => `[${r.code}] ${r.title}\n${r.text}`).join('\n\n');
  const call = originalCall || 'not provided';

  return `You are an expert ${corpus.displayName} officiating analyst. Decide whether the referee's call was correct, using ONLY the observation and the candidate rules below. Do not invent rules or facts not in the observation.

OBSERVATION (what happened in the clip):
${playDescription}

REFEREE'S CALL ON THE FIELD:
${call}

CANDIDATE RULES (a retrieval shortlist; only some will actually apply):
${retrievedRulesText}

Return ONLY a JSON object with exactly these fields:
{
  "verdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "2-4 sentences explaining the decision and referencing the applicable rule by name",
  "ruleCodes": ["<code>"]
}

Rules for your answer:
- verdict FAIR_CALL if the referee's call was correct, BAD_CALL if it was wrong, INCONCLUSIVE if the observation is insufficient to decide.
- ruleCodes must be a subset of the candidate codes above — cite ONLY the rule(s) that directly apply (usually exactly one). If none apply, return an empty array and verdict INCONCLUSIVE.
- If the description says the key moment was occluded, off-screen, or ambiguous, you MUST return INCONCLUSIVE.
- Use the exact code strings shown in brackets.`;
}

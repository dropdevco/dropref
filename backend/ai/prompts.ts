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

Return 3-6 sentences of plain description.`;
}

export function buildAdjudicationPrompt(corpus: SportCorpus, playDescription: string, originalCall: string | null, rules: CitedRule[]): string {
  const retrievedRulesText = rules.map(r => `[${r.code}] ${r.title}\n${r.text}`).join('\n\n');
  const call = originalCall || 'not provided';

  return `You are ${corpus.analystPersona}. Below is a description of a play and the
ONLY rules you may cite.

SPORT: ${corpus.displayName} (${corpus.governingBody})

PLAY DESCRIPTION:
${playDescription}

CALL MADE BY THE ${corpus.officialTitle.toUpperCase()}: ${call}

AVAILABLE RULES (cite ONLY these):
${retrievedRulesText}

Decide whether the original call was correct.

Rules for your answer:
- Cite ONLY rule codes that appear in AVAILABLE RULES. Never invent
  a rule code. If no available rule addresses the play, return
  INCONCLUSIVE and say the corpus does not cover this situation.
- If the description says the key moment was occluded, off-screen,
  or ambiguous, you MUST return INCONCLUSIVE.
- If no original call was provided, judge the most likely call and
  state which call you assumed.
- Confidence HIGH only if the description is unambiguous AND a rule
  directly addresses it. Default to MEDIUM.

Return ONLY valid JSON, no markdown fences, adhering to this schema:
{
  "verdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "reasoning": "2-4 sentences connecting the play to the rule text",
  "ruleCodes": ["exact codes from AVAILABLE RULES"]
}`;
}

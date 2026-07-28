import { SportCorpus, CitedRule } from '../../types/contract';

export function buildObservationPrompt(corpus: SportCorpus, originalCall: string | null, cvMetadata: any = null): string {
  const focusContext = originalCall 
    ? `The original call on the field was: "${originalCall}". \n\nCRITICAL INSTRUCTION: You MUST use this call to filter out irrelevant information. Do NOT report on things unrelated to the call. For example, if the call is "offside", focus entirely on player positioning relative to the defense and the ball release; ignore minor fouls or handballs elsewhere. If the call is a "foul", focus strictly on the physical contact of the players involved.`
    : `For this sport specifically, pay attention to: ${corpus.observationHints}`;

  const cvContext = cvMetadata
    ? `\n[COMPUTER VISION SYSTEM DATA]\nThe provided video has been pre-processed. Bounding boxes and skeletal tracking lines have been drawn onto the players. Metadata found: ${JSON.stringify(cvMetadata)}\n\nCRITICAL INSTRUCTION: The 'telemetry' array contains physics events (e.g. PLAYER_PROXIMITY_DETECTED, BALL_ACCELERATION_SPIKE). Use this metadata strictly as a map to locate the critical moments in the video or key frame images. Do NOT just regurgitate or read back the JSON data in your report. You must watch the video or images at those specific frames and describe the physical visual action (e.g., describe the actual tackle or foul visually). Never mention "units of distance" or "frames" in your final report.\n`
    : '';

  const strictGroundingContext = `CRITICAL INSTRUCTION ON HALLUCINATIONS: You MUST NOT guess or assume any details about the broader field or player roles that are not 100% explicitly visible in the video.
- Do NOT mention the "penalty area", "18-yard box", "goal line", or "out of bounds" unless you can clearly see the painted white lines on the grass in the frame.
- Do NOT assume a player is the "last defender" or guess their exact tactical position. Just call them "attacker" and "defender" based on ball possession.
- If the video has a pure black background (Computer Vision mode), do NOT guess jersey colors, field markings, or environmental details. Describe ONLY the isolated objects/skeletons provided.
- CRITICAL: Do NOT guess or hallucinate the outcome of a tackle or the ball's trajectory (e.g., "the ball deflected away" or "sent flying forward") unless you can see it with absolute 100% certainty. If the frames are blurry, simply describe the leg extensions without guessing what happened to the ball.`;

  return `You are a neutral sports video analyst. Watch this ${corpus.displayName} clip.

Describe ONLY what is physically observable. Do not judge whether any
call was correct. Do not mention rules.

${focusContext}
${cvContext}
${strictGroundingContext}

Report:
1. The sequence of events, in order
2. Player positions and movement at the decisive moment
3. Body positioning, point of contact, ball or object position

CRITICAL: Do NOT hedge or be overly cautious. Vision models often complain about "wide angles" or "fast action" — ignore this instinct. If you can reasonably infer the point of contact from the players' momentum, trajectories, or reactions, state it confidently. Do not use phrases like "not clearly visible" or "hard to tell" unless the action is literally physically blocked by another object or completely off-screen.

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

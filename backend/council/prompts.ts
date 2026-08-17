import type { CitedRule, SportRule } from '../../types/contract';
import { ruleRef } from './rule-ref';
import type {
  CouncilInput,
  CouncilRole,
  CouncilSeat,
  DebateStatement,
  PanelOpinion,
} from './types';

/**
 * Prompt construction, plus the citation round-trip that pairs with it.
 *
 * Every rule is presented — and must be cited back — by its `ruleRef()` string,
 * never by bare `code`. Soccer alone reuses "Law 12.1" across five distinct
 * rules, so resolving a bare code picks whichever entry a Map saw last and
 * silently mis-cites (see rule-ref.ts).
 */

/* ------------------------------------------------------------------ */
/* Rule presentation + citation validation                             */
/* ------------------------------------------------------------------ */

export function renderCandidates(candidates: SportRule[]): string {
  if (candidates.length === 0) return '(no candidate rules were retrieved)';
  return candidates
    .map((r) => `[${ruleRef(r)}]\nTitle: ${r.title}\nText: ${r.text}`)
    .join('\n\n');
}

/** Just the ref strings, for the "cite only from this list" instruction. */
export function refList(candidates: SportRule[]): string {
  return candidates.map((r) => `"${ruleRef(r)}"`).join(', ') || '(none)';
}

/**
 * Ref-aware equivalent of `filterValidRuleCodes`. Drops anything outside the
 * candidate shortlist — including a bare code a model emitted despite the
 * instruction, since a bare code cannot be resolved unambiguously.
 */
export function filterValidRuleRefs(
  refs: string[],
  candidates: SportRule[],
): string[] {
  const valid = new Set(candidates.map((r) => ruleRef(r)));
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim();
    if (!valid.has(ref)) {
      console.warn(`[Council] dropped out-of-set rule ref: ${JSON.stringify(raw)}`);
      continue;
    }
    if (seen.has(ref)) continue;
    seen.add(ref);
    kept.push(ref);
  }
  return kept;
}

/** Resolve validated refs back to the frozen `CitedRule` shape. */
export function citeRulesByRef(
  refs: string[],
  candidates: SportRule[],
): CitedRule[] {
  const byRef = new Map(candidates.map((r) => [ruleRef(r), r]));
  return refs
    .map((ref) => byRef.get(ref))
    .filter((r): r is SportRule => Boolean(r))
    .map((r) => ({ code: r.code, title: r.title, text: r.text, source: r.source }));
}

/* ------------------------------------------------------------------ */
/* Role framing                                                        */
/* ------------------------------------------------------------------ */

/**
 * The lenses. These are intentionally NOT paraphrases of one another — a
 * council whose seats are told the same thing in five voices produces five
 * correlated answers and measures nothing.
 */
const ROLE_FRAMING: Record<CouncilRole, string> = {
  literalist: `You are a LITERALIST. You decide strictly on the words of the rule text as written.
- Quote or paraphrase the operative clause and check the observation against it element by element.
- Do not import intent, precedent, or "what referees usually do". If the text does not say it, it is not a requirement.
- If the observation does not establish an element the text requires, that element is NOT established — say so.
- You are unmoved by how severe or unfair something looks; only by whether the described facts satisfy the text.`,

  contextualist: `You are a CONTEXTUALIST. You decide on the rule's purpose applied to the match situation.
- Weigh intent, severity, momentum, proximity, and whether the offence affected the play.
- Rules exist to produce fair outcomes; a technically-satisfied clause applied against its own purpose is a bad call.
- Consider what a competent official at this level, seeing this in real time, would be expected to call.
- Where the letter and the purpose of the rule diverge, say so explicitly and explain which should govern here.`,

  skeptic: `You are a SKEPTIC. Your job is to find what the evidence does NOT establish.
- Enumerate the facts the verdict would depend on, then mark each as OBSERVED or ASSUMED.
- Angles, occlusion, frame gaps, missing contact detail, and unstated player positions all limit what can be concluded.
- You are biased toward INCONCLUSIVE and you should say INCONCLUSIVE whenever a load-bearing fact is merely assumed.
- Do not manufacture doubt about facts the observation states plainly. Attack gaps, not the record.`,

  prosecutor: `You are the PROSECUTOR. Argue that the offence DID occur and build the strongest good-faith case for it.
- Identify the most serious rule the described conduct plausibly breaches and marshal the observation's facts for it.
- Give full weight to indicators of an offence: contact, force, timing, position, the result of the challenge.
- Argue hard, but do not fabricate. Every fact you rely on must appear in the observation.
- Then state your verdict honestly. If, having built the best possible case, it still does not hold, say so — an
  advocate who cannot lose is worthless to this council.`,

  defender: `You are the DEFENDER. Argue that the offence did NOT occur and build the strongest good-faith case against it.
- Look for the legal reading: ball played first, incidental contact, legitimate use of the body, players onside, no
  causal link between the contact and the outcome.
- Give full weight to exculpatory detail and to elements of the offence that the observation never establishes.
- Argue hard, but do not fabricate. Every fact you rely on must appear in the observation.
- Then state your verdict honestly. If, having built the best possible defence, the offence still clearly occurred,
  say so — an advocate who cannot lose is worthless to this council.`,

  chair: `You are the CHAIR of an officiating council. You are the only participant who has seen every opinion.
- You are a judge, not a vote-counter. A single well-reasoned seat citing the operative rule outranks a confident majority.
- Discount an opinion that asserts facts absent from the observation, cites a rule that does not govern, or restates
  its conclusion instead of arguing for it.
- The adversarial seats are ADVOCATES by construction; read their conclusions, not their zeal, as evidence.
- If the seats disagree because the observation genuinely cannot settle the question, the answer is INCONCLUSIVE.`,
};

const SHARED_RULES = `Hard constraints on your answer:
- Decide using ONLY the observation and the candidate rules given. Never invent facts or rules.
- Cite rules by their exact bracketed reference string. Codes alone are ambiguous — several distinct rules share a code.
- Cite only the rule(s) that directly govern (usually exactly one). If none govern, cite nothing and answer INCONCLUSIVE.
- "selfProbability" is your honest probability that your own verdict is correct, 0..1. Be calibrated, not polite:
  reserve values above 0.9 for cases where the observation leaves no room to be wrong.`;

const VERDICT_KEY = `Verdict meanings:
- FAIR_CALL — the decision recorded on the field was correct.
- BAD_CALL — the decision recorded on the field was wrong.
- INCONCLUSIVE — the observation is insufficient to decide either way.`;

const NO_CALL_KEY = `No referee decision was recorded, so judge the PLAY itself:
- FAIR_CALL — the play was legal; nothing should have been penalised.
- BAD_CALL — an offence occurred that should have been penalised.
- INCONCLUSIVE — the observation is insufficient to decide either way.`;

/**
 * Facts the observers could not agree on, rendered for the seats.
 *
 * Empty string when nothing was contested, so the prompt is byte-identical to
 * the pre-graph one on that path — a block reading "(nothing contested)" would
 * have changed every existing prompt and made the A/B measure the wording
 * change as well as the graph.
 */
function contestedBlock(input: CouncilInput): string {
  const contested = (input.contested ?? []).filter((c) => c.trim() !== '');
  if (contested.length === 0) return '';
  return `

FACTS THE OBSERVERS COULD NOT AGREE ON:
${contested.map((c) => `- ${c}`).join('\n')}

Two independent observers watched this clip and disagreed about the points above. Treat each as UNSETTLED,
not as a detail to pick whichever way suits your lens. If your verdict depends on one of them, say so
explicitly and prefer INCONCLUSIVE.`;
}

function caseBlock(input: CouncilInput): string {
  return `SPORT: ${input.displayName}

OBSERVATION (what the clip showed):
${input.observation}${contestedBlock(input)}

${
  input.originalCall
    ? `REFEREE'S CALL ON THE FIELD:\n${input.originalCall}\n\n${VERDICT_KEY}`
    : NO_CALL_KEY
}

CANDIDATE RULES (a retrieval shortlist — some will not apply):
${renderCandidates(input.candidates)}

Valid reference strings: ${refList(input.candidates)}`;
}

export interface SeatPrompt {
  system: string;
  user: string;
}

/* ------------------------------------------------------------------ */
/* Stage 1 — independent opinion                                       */
/* ------------------------------------------------------------------ */

export function buildPanelPrompt(
  input: CouncilInput,
  seat: CouncilSeat,
): SeatPrompt {
  return {
    system: `${ROLE_FRAMING[seat.role]}

You sit on a council of independent officiating analysts. You are answering ALONE — you have not seen the other seats' views and must not guess at them. Reason from your own lens and commit to a verdict.

${SHARED_RULES}`,
    user: `${caseBlock(input)}

Return ONLY this JSON object:
{
  "verdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "selfProbability": 0.0,
  "reasoning": "2-4 sentences arguing from your lens, naming the rule you rely on",
  "citedRuleRefs": ["<exact reference string from the list above>"]
}`,
  };
}

/* ------------------------------------------------------------------ */
/* Stage 2 — debate                                                    */
/* ------------------------------------------------------------------ */

/** Stable A, B, C… labels in seat order. */
export function seatLabels(opinions: PanelOpinion[]): Map<string, string> {
  const labels = new Map<string, string>();
  opinions.forEach((o, i) => labels.set(o.seatId, `Seat ${String.fromCharCode(65 + i)}`));
  return labels;
}

/**
 * Render the panel for the debate round WITHOUT model names.
 *
 * The role is shown because a critique needs to know which lens produced an
 * argument; the model is hidden because seats otherwise defer to a recognised
 * brand instead of to the argument, which collapses the diversity the roster
 * exists to create.
 */
export function anonymiseOpinions(
  opinions: PanelOpinion[],
  labels: Map<string, string>,
  excludeSeatId?: string,
): string {
  const shown = opinions.filter((o) => o.seatId !== excludeSeatId);
  if (shown.length === 0) return '(no other opinions were returned)';
  return shown
    .map((o) => {
      const refs = o.citedRuleRefs.length ? o.citedRuleRefs.join('; ') : 'none';
      return `${labels.get(o.seatId) ?? 'Seat ?'} (lens: ${o.role})
  verdict: ${o.verdict} (confidence ${o.confidence}, self-probability ${o.selfProbability.toFixed(2)})
  cites: ${refs}
  argument: ${o.reasoning}`;
    })
    .join('\n\n');
}

export function buildDebatePrompt(
  input: CouncilInput,
  seat: CouncilSeat,
  own: PanelOpinion,
  othersBlock: string,
): SeatPrompt {
  return {
    system: `${ROLE_FRAMING[seat.role]}

The council's first round is complete and the seats did not agree. You are now in the debate round. You can see the other seats' arguments, anonymised. Your task is to engage with the STRONGEST argument against you and then either hold your position or revise it.

Change your mind only when an opposing argument identifies a rule element or an observed fact you got wrong. Do NOT change your mind merely because you are outnumbered — a council that converges by social pressure is a council with one member.

${SHARED_RULES}`,
    user: `${caseBlock(input)}

YOUR FIRST-ROUND OPINION:
  verdict: ${own.verdict} (confidence ${own.confidence}, self-probability ${own.selfProbability.toFixed(2)})
  cites: ${own.citedRuleRefs.length ? own.citedRuleRefs.join('; ') : 'none'}
  argument: ${own.reasoning}

THE OTHER SEATS:
${othersBlock}

Return ONLY this JSON object:
{
  "revisedVerdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "revisedConfidence": "HIGH" | "MEDIUM" | "LOW",
  "revisedProbability": 0.0,
  "critique": "Name the strongest opposing argument, then say precisely why you do or do not yield to it",
  "citedRuleRefs": ["<exact reference string from the list above>"],
  "changedMind": false
}`,
  };
}

/* ------------------------------------------------------------------ */
/* Stage 3 — chair                                                     */
/* ------------------------------------------------------------------ */

export function buildChairPrompt(
  input: CouncilInput,
  chair: CouncilSeat,
  opinions: PanelOpinion[],
  debate: DebateStatement[],
): SeatPrompt {
  const labels = seatLabels(opinions);
  const round1 = anonymiseOpinions(opinions, labels);
  const round2 = debate.length
    ? debate
        .map(
          (d) =>
            `${labels.get(d.seatId) ?? 'Seat ?'} (lens: ${d.role})
  revised verdict: ${d.revisedVerdict} (confidence ${d.revisedConfidence}, self-probability ${d.revisedProbability.toFixed(2)})
  changed mind: ${d.changedMind ? 'yes' : 'no'}
  cites: ${d.citedRuleRefs.length ? d.citedRuleRefs.join('; ') : 'none'}
  critique: ${d.critique}`,
        )
        .join('\n\n')
    : '(the debate round did not run)';

  return {
    system: `${ROLE_FRAMING[chair.role]}

${SHARED_RULES}`,
    user: `${caseBlock(input)}

ROUND 1 — INDEPENDENT OPINIONS:
${round1}

ROUND 2 — DEBATE:
${round2}

The council remained split. Settle it.

Return ONLY this JSON object:
{
  "verdict": "FAIR_CALL" | "BAD_CALL" | "INCONCLUSIVE",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "selfProbability": 0.0,
  "reasoning": "2-4 sentences stating the ruling as the council's final answer, naming the governing rule",
  "rationale": "Which seat's argument you found decisive and which you discounted, and why",
  "citedRuleRefs": ["<exact reference string from the list above>"]
}`,
  };
}

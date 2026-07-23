**RefCheck AI**

6-Hour Sprint Plan · Football, Soccer & Lacrosse

*BorderHack Sponsored Challenge  ·  Two-Person Team  ·  AI-Harness Assisted*

**Dev A: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_          Dev B: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_**

**Start time: \_\_\_\_\_\_\_\_\_\_\_\_\_\_          Hard deadline: \_\_\_\_\_\_\_\_\_\_\_\_\_\_**

**Repo URL: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_          Live URL: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_**

# **0\. Read This First — What Changed**

Six hours with three sports is a fundamentally different problem than a weekend with one. Two constraints now drive every decision in this document:

* **Three sports is only survivable because the sports are data, not code.** You write one pipeline. Each sport is a JSON file. Adding lacrosse must cost you a file, not a feature branch.

* **You are not typing this code.** Claude Code or a similar harness writes the implementation while you two do architecture, prompts, rule curation, and judgment. Section 4 gives you the exact prompts to paste.

**The scope trap: three sports sounds like 3× the work. Built correctly it is 1× the work plus three JSON files. If you find yourself writing sport-specific code paths, stop — you have taken a wrong turn that will cost you the deadline.**

Everything is ruthlessly scoped to six hours. Anything that was optional in a weekend plan has been cut.

# **1\. The Sports — Scope Lock**

Football, soccer, and lacrosse. Each gets a small, deliberately chosen set of call types. Do not expand these mid-sprint.

| Sport | Call types in scope | Why these | Rulebook source |
| :---- | :---- | :---- | :---- |
| Soccer | Offside, handball, foul vs. dive (simulation), penalty area contact | Most visually decidable of the three. Offside is nearly binary given a decent angle. | IFAB Laws of the Game — free PDF, well numbered |
| Football | Pass interference, holding, targeting, catch vs. incomplete | High-controversy, high-recognition calls. Catch/no-catch is famously contested — good demo material. | NCAA or NFL rulebook — both public |
| Lacrosse | Crosse checks (legal vs. slash), crease violation, offside, illegal body check | Under-served sport, differentiates your submission. Slash vs. legal check is genuinely visual. | NCAA Men's Lacrosse rules — public PDF |

**Lacrosse is your pitch differentiator. Every other team will do basketball or soccer. Lead the demo with soccer (most reliable), but mention lacrosse early — it signals the architecture genuinely generalizes rather than being hardcoded to one sport.**

## **Rule budget — hard cap**

12 to 15 rules per sport. Not more. That is roughly 40 rules total, and it is achievable in the time you have because the AI harness drafts them and you verify.

* Soccer: \~12 rules covering the four call types above

* Football: \~15 rules (this rulebook is the wordiest — budget accordingly)

* Lacrosse: \~12 rules

**Quality over coverage. A wrong or invented rule text destroys your credibility with judges far more than a missing rule does.**

# **2\. Architecture — Sport-as-Data**

This is the single most important design decision in the document. Everything else follows from it.

One pipeline. One prompt template. One retrieval function. Three JSON files. The sport is a parameter that selects a corpus and injects sport-specific vocabulary into the prompt — it never branches the code.

## **Directory shape**

/data/sports/  
   soccer.json  
   football.json  
   lacrosse.json  
   
/lib/sports.ts         \<- registry: loads a corpus by sport id  
/lib/ai/pipeline.ts    \<- ONE pipeline, takes sportId as a param  
/lib/ai/prompts.ts     \<- ONE template, sport values interpolated  
/lib/rules/retrieve.ts \<- ONE retriever, indexes whichever corpus

## **The sport file schema — agree on this in the first 20 minutes**

{  
  "id": "soccer",  
  "displayName": "Soccer",  
  "governingBody": "IFAB Laws of the Game 2024/25",  
  "officialTitle": "referee",  
  "analystPersona": "a football (soccer) officiating analyst",  
  "observationHints": "Note the position of the second-last defender  
     at the moment the ball is played, arm position relative to the  
     body, and whether contact preceded the ball.",  
  "commonCalls": \["offside", "handball", "foul", "dive", "penalty"\],  
  "rules": \[  
    {  
      "code": "Law 11.1",  
      "title": "Offside Position",  
      "text": "\<verbatim rule text\>",  
      "keywords": \["offside", "second-last defender", "level",  
                   "ball played", "nearer to goal"\],  
      "callTypes": \["offside"\]  
    }  
  \]  
}

**Every sport file has identical shape. If lacrosse needs a field soccer does not, add it to all three as optional. The moment the shapes diverge, your pipeline needs branches and you lose the time advantage.**

## **Why this wins you points in the pitch**

* “Adding a fourth sport is a JSON file, not a code change” is a strong, verifiable claim.

* It directly answers the challenge brief's requirement for a structure expandable to more sports later.

* You can demo it: show the three sport files side by side and point out the pipeline never mentions a sport by name.

# **3\. Division of Labor — Six Hours, Two People**

With a harness writing code, your roles shift. You are no longer typists — you are a product owner and a domain expert, each driving your own harness session.

|  | Dev A — App & Delivery | Dev B — Rules & Intelligence |
| :---- | :---- | :---- |
| Drives | Harness session on frontend \+ API scaffolding | Harness session on corpus generation \+ prompts |
| Owns | UI, upload, sport selector, results, deploy, README | Three sport JSON files, prompt template, retrieval, verdict logic |
| Hour 0–1 | Scaffold \+ deploy skeleton \+ freeze contract | Generate \+ verify soccer corpus |
| Hour 1–3 | Full UI against mocks, all states | Football \+ lacrosse corpora, pipeline working on one clip |
| Hour 3–4 | Integration, sample clips | Prompt tuning across all three sports |
| Hour 4–5 | Error states, mobile, README | Eval pass, inconclusive verification |
| Hour 5–6 | Deploy freeze, demo rehearsal | Limitations writeup, pitch technical half |

## **File ownership — the no-conflict contract**

**Hard rule: you do not edit a file the other person owns. Ask instead. Ten seconds of asking beats an hour of merge pain — and with harnesses generating code fast, conflicts get expensive quickly.**

| Path | Owner |
| :---- | :---- |
| /app/page.tsx, /components/\*\*, /lib/api-client.ts | Dev A |
| /app/globals.css, tailwind config, /public/samples/\*\* | Dev A |
| /app/api/analyze/route.ts | Dev B |
| /lib/ai/\*\*, /lib/rules/\*\*, /lib/sports.ts | Dev B |
| /data/sports/\*.json | Dev B |
| /types/contract.ts | SHARED — frozen after minute 20 |
| /mocks/\*.json | Dev A writes, Dev B matches |
| README.md, LICENSE, .env.example | Dev A |

* Branches: Dev A on feat/ui-\*, Dev B on feat/ai-\*. Merge to main every 90 minutes — shorter sprint means tighter merge cadence.

* Announce before merging. Pull and rebase first.

## **The frozen contract — write this together, minute 10**

export type SportId \= 'soccer' | 'football' | 'lacrosse';  
export type Verdict \= 'FAIR\_CALL' | 'BAD\_CALL' | 'INCONCLUSIVE';  
export type Confidence \= 'HIGH' | 'MEDIUM' | 'LOW';  
   
export interface CitedRule {  
  code: string; title: string; text: string;  
}  
   
export interface AnalyzeResponse {  
  sport: SportId;  
  verdict: Verdict;  
  confidence: Confidence;  
  playDescription: string;  
  reasoning: string;  
  rulesCited: CitedRule\[\];  
  originalCall: string | null;  
  processingMs: number;  
}  
   
export interface AnalyzeError {  
  error: string;  
  code: 'FILE\_TOO\_LARGE' | 'BAD\_FORMAT' | 'MODEL\_ERROR'  
      | 'TIMEOUT' | 'RATE\_LIMIT' | 'UNSUPPORTED\_SPORT';  
}

# **4\. AI Harness Playbook — Copy-Paste Prompts**

These are prompts for your coding harness (Claude Code, Cursor, or similar), not prompts for the app itself. App prompts are in Section 6\. Paste these near-verbatim and adjust paths.

**Run two separate harness sessions — one per person, scoped to your own files. Two harnesses in one repo touching the same files will produce conflicts faster than you can resolve them. Tell each session explicitly which directories it owns.**

## **4.1 Kickoff prompt — Dev A, minute 0**

Scaffold a Next.js 14 App Router project in TypeScript with Tailwind  
and shadcn/ui for a video analysis app called RefCheck AI.  
   
Constraints:  
\- You own ONLY: /app/page.tsx, /components/\*\*, /lib/api-client.ts,  
  /app/globals.css, /public/\*\*. Do not create or edit anything under  
  /lib/ai, /lib/rules, /data, or /app/api. My teammate owns those.  
\- Create /types/contract.ts with exactly the interfaces I paste below,  
  then never modify it.  
\- Build the entire UI against mock JSON in /mocks. Add a USE\_MOCK  
  boolean in api-client.ts that switches between mocks and the real  
  endpoint.  
   
Single page, three states: idle (upload \+ sport select \+ optional  
'what was the call' input \+ sample clips), analyzing (video preview,  
staged progress copy, elapsed timer), result (verdict badge,  
confidence, play description, reasoning, cited rules accordion).  
   
Three sports: soccer, football, lacrosse. The sport list must come  
from a single array so adding a sport is one line.  
   
Build all three verdict states and every error state against mocks.  
Do not skip the error UI.  
   
\<paste contract.ts here\>

## **4.2 Corpus generation prompt — Dev B, minute 0**

This is your highest-leverage prompt of the whole sprint. Run it once per sport.

I am building a rules corpus for an officiating analysis app.  
Produce /data/sports/soccer.json following this exact schema:  
   
\<paste the sport file schema from Section 2\>  
   
Requirements:  
\- Exactly 12 rules covering: offside, handball, foul vs. simulation,  
  and penalty-area contact.  
\- Source: IFAB Laws of the Game. Use the real Law numbers.  
\- The 'text' field must be a faithful statement of the actual rule.  
  If you are not confident a rule number or its wording is correct,  
  set "needsVerification": true on that entry so I can check it.  
  Do NOT guess silently.  
\- Each rule needs 5-8 keywords chosen for lexical retrieval against a  
  plain-language description of a play — use the words a commentator  
  would say, not formal legal terms.  
\- observationHints should tell a video model what to look for in this  
  sport specifically.  
   
Output valid JSON only.

**The needsVerification flag is the important part. The harness will confidently invent rule numbers otherwise, and a fabricated rule citation in front of judges is the worst possible failure. Spot-check every flagged entry against the real rulebook, and sample a few unflagged ones too.**

*Then repeat for football and lacrosse, changing the sport, call types, and governing body. Keep the schema identical.*

## **4.3 Pipeline prompt — Dev B, after corpora exist**

Build a sport-agnostic analysis pipeline. You own ONLY /lib/ai/\*\*,  
/lib/rules/\*\*, /lib/sports.ts, /data/\*\*, /app/api/analyze/route.ts.  
Do not touch /components, /app/page.tsx, or /types/contract.ts.  
   
Requirements:  
\- /lib/sports.ts loads a sport corpus by id from /data/sports/.  
  Adding a sport must require ONLY a new JSON file, no code change.  
\- Two-stage pipeline:  
    Stage 1: send the video to Gemini with a neutral observation  
             prompt. Return a factual play description, no verdict.  
    Stage 2: retrieve top 5 rules from the sport corpus using the  
             description, then ask the model to adjudicate citing  
             ONLY those rules.  
\- Retrieval: Fuse.js over keywords (weight 3), title (2), text (1).  
\- The prompt template lives in /lib/ai/prompts.ts and interpolates  
  sport-specific fields from the corpus file. There must be NO  
  sport-specific branching anywhere in the pipeline code.  
\- Validate the model's JSON with Zod. On failure retry once, then  
  return INCONCLUSIVE with LOW confidence rather than throwing.  
\- Filter returned rule codes against the corpus server-side. Drop any  
  code that does not exist. Log when this happens.  
\- Set responseMimeType application/json, temperature 0.2.  
\- Route must export maxDuration \= 60 and runtime \= 'nodejs'.  
\- Return the AnalyzeResponse shape exactly. Include processingMs.  
   
\<paste contract.ts\>

## **4.4 Eval harness prompt — Dev B, hour 4**

Write a script at /lib/eval/run.ts that reads /lib/eval/cases.json  
(each case: video path, sport, originalCall, expectedVerdict), runs  
each through the deployed /api/analyze endpoint, and prints a table  
of expected vs. actual verdict, confidence, cited rule codes, and  
latency. Print a pass rate per sport at the end.  
   
Do not mock anything — hit the real deployed URL.

## **4.5 Guardrail prompts — use these when the harness drifts**

* “You just edited a file I said you do not own. Revert that change and tell me what you needed from it instead.”

* “This code branches on sport. Refactor so the difference lives in the sport JSON file, not in the pipeline.”

* “Do not add a dependency without asking. What problem does it solve that the current stack does not?”

* “We have 90 minutes left. Stop adding features. What is the single highest-risk thing that is still broken?”

**Harnesses expand scope when you are not looking. Every 45 minutes, ask yours: “list every file you have changed since my last message.” It is a cheap check that catches ownership violations before they become merge conflicts.**

# **5\. The Stack — Decided For You**

| Layer | Pick | Why |
| :---- | :---- | :---- |
| Framework | Next.js 14+ App Router, TypeScript | Frontend and API in one repo, one deploy, no CORS |
| Hosting | Vercel | Git push \= deploy. Zero config. |
| Styling | Tailwind \+ shadcn/ui | Card, badge, select, accordion, progress in minutes |
| AI model | Gemini 2.0 / 2.5 Flash | Native video input — no ffmpeg, no frame extraction |
| AI SDK | @google/generative-ai | Official, simple |
| Retrieval | Fuse.js over the sport corpus | Zero infra. A vector DB for 40 rules is a trap. |
| Validation | Zod | Guards both the request and the model's JSON output |
| Icons | lucide-react | Ships with shadcn |
| Video preview | Native \<video\> tag | Do not install a player library |

npx create-next-app@latest refcheck-ai \--typescript \--tailwind \--app  
cd refcheck-ai  
npx shadcn@latest init  
npx shadcn@latest add card badge button progress accordion alert select  
npm i @google/generative-ai zod fuse.js lucide-react  
npx vercel   \# deploy immediately, even empty

**Gemini takes video natively. Teams that build ffmpeg frame extraction will lose 2–3 hours — which in a six-hour sprint is the whole project. Do not do it.**

## **Two things teams forget, every time**

* **GEMINI\_API\_KEY must be set in Vercel's environment variables,** not just .env.local. Do this in the first ten minutes.

* **Vercel hobby functions time out at 10 seconds.** Video analysis exceeds that. Set maxDuration \= 60 (needs Pro) or deploy the API on Render. Decide in minute 15, not hour 5\.

# **6\. App Prompts — Sport-Agnostic Templates**

These are the prompts the app sends at runtime. Both interpolate values from the sport JSON, so one template serves all three sports.

## **6.1 Stage 1 — Observation**

You are a neutral sports video analyst. Watch this {displayName} clip.  
   
Describe ONLY what is physically observable. Do not judge whether any  
call was correct. Do not mention rules.  
   
For this sport specifically, pay attention to: {observationHints}  
   
Report:  
1\. The sequence of events, in order  
2\. Player positions and movement at the decisive moment  
3\. Body positioning, point of contact, ball or object position  
4\. Camera limitations — state explicitly what is NOT visible,  
   obscured, or off-screen  
   
If the clip is too short, too low quality, or the key moment is not  
clearly visible, say so plainly and specifically.  
   
Return 3-6 sentences of plain description.

## **6.2 Stage 2 — Adjudication**

You are {analystPersona}. Below is a description of a play and the  
ONLY rules you may cite.  
   
SPORT: {displayName}  ({governingBody})  
   
PLAY DESCRIPTION:  
{playDescription}  
   
CALL MADE BY THE {officialTitle}: {originalCall or 'not provided'}  
   
AVAILABLE RULES (cite ONLY these):  
{retrievedRules}  
   
Decide whether the original call was correct.  
   
Rules for your answer:  
\- Cite ONLY rule codes that appear in AVAILABLE RULES. Never invent  
  a rule code. If no available rule addresses the play, return  
  INCONCLUSIVE and say the corpus does not cover this situation.  
\- If the description says the key moment was occluded, off-screen,  
  or ambiguous, you MUST return INCONCLUSIVE.  
\- If no original call was provided, judge the most likely call and  
  state which call you assumed.  
\- Confidence HIGH only if the description is unambiguous AND a rule  
  directly addresses it. Default to MEDIUM.  
   
Return ONLY valid JSON, no markdown fences:  
{  
  "verdict": "FAIR\_CALL" | "BAD\_CALL" | "INCONCLUSIVE",  
  "confidence": "HIGH" | "MEDIUM" | "LOW",  
  "reasoning": "2-4 sentences connecting the play to the rule text",  
  "ruleCodes": \["exact codes from AVAILABLE RULES"\]  
}

**The two-stage split is your best pitch material. The model cannot cite a rule that was not retrieved from your corpus, and you filter codes server-side as a second layer. That is the answer to “how do you know it isn't inventing rules?”**

# **7\. The Six-Hour Timeline**

Minute markers, not hour markers. Every block has a hard exit condition — if you miss it, cut scope rather than sliding the schedule.

## **0:00 – 0:20  Together — Setup**

* Run the scaffold commands. Push to GitHub with MIT license.

* Deploy the empty skeleton to Vercel. Confirm the URL loads.

* Both add GEMINI\_API\_KEY to Vercel env vars.

* Write /types/contract.ts together. Freeze it.

* Agree the sport file schema. Freeze it.

* Decide the timeout strategy (Vercel Pro vs. Render). Do not defer this.

**Exit condition: a live URL exists and both contracts are frozen.**

## **0:20 – 1:30  Split**

| Dev A | Dev B |
| :---- | :---- |
| Paste harness prompt 4.1. Review what it scaffolds. | Paste harness prompt 4.2 for soccer. Verify every flagged rule. |
| Upload zone, sport selector, validation, preview | Repeat for football and lacrosse |
| Write three mock responses — one per verdict | Spot-check unflagged rules too — sample at least 3 per sport |

**Exit condition: UI renders all three verdict states from mocks; three corpora exist and are verified.**

## **1:30 – 3:00  Split**

| Dev A | Dev B |
| :---- | :---- |
| Loading state with staged copy \+ elapsed timer | Paste harness prompt 4.3. Get the pipeline running. |
| Result card: badge, confidence, reasoning, rules accordion | One real clip through end to end, any sport |
| Error states for all six error codes | Verify no sport-specific branching exists in the pipeline |

**Exit condition: Dev B has one real verdict from a real clip on localhost.**

## **3:00 – 3:30  Together — Integration Checkpoint**

**This is the highest-risk moment of the sprint. Protect it. No feature work by either person until a real clip returns a real verdict on the deployed URL.**

* Flip USE\_MOCK to false.

* Run one clip per sport end to end.

* Push and verify on the deployed URL — especially the function timeout.

**Exit condition: deployed URL returns a real verdict for all three sports.**

## **3:30 – 4:45  Split**

| Dev A | Dev B |
| :---- | :---- |
| Sample clips — two per sport, hosted in /public/samples | Prompt tuning against real failures across all three sports |
| Mobile responsive pass | Verify INCONCLUSIVE actually triggers on an ambiguous clip |
| README with screenshot and setup steps | Confirm server-side rule-code filtering works |

## **4:45 – 5:15  Freeze**

* Feature freeze. Fixes only. No exceptions.

* Run the eval set on the deployed URL, not localhost.

* Each of you runs the full demo flow independently on your phone.

* Record a backup demo video now, while things work.

## **5:15 – 6:00  Pitch Prep**

* Dev A opens: problem, live demo, user flow. Demo soccer first — most reliable.

* Dev B closes: sport-as-data architecture, two-stage pipeline, hallucination prevention, limitations.

* Rehearse twice, timed.

* Prepare answers to the three questions in Section 8\.

# **8\. The Pitch — Three Questions You Will Be Asked**

| Question | Your answer |
| :---- | :---- |
| How do you know the AI is not making up rules? | Two-stage pipeline. Stage 2 only receives rules retrieved from our curated corpus and is instructed to cite only those. We then filter returned codes against the corpus server-side and drop anything that does not exist. It is structurally prevented, not prompted away. |
| How would you add a fourth sport? | One JSON file. The pipeline has zero sport-specific branches — sport-specific behavior lives entirely in the corpus file's observationHints and analystPersona fields. We can show you the three files side by side. |
| What happens when it is wrong? | We built INCONCLUSIVE as a first-class outcome, not a failure mode. If the key moment is occluded or no retrieved rule addresses the play, it declines to judge. We would rather return no verdict than a confident wrong one — and we can demo that path live. |

# **9\. Live Status Board**

Statuses: NOT STARTED / IN PROGRESS / BLOCKED / DONE

| Item | Owner | Status | Notes |
| :---- | :---- | :---- | :---- |
| Repo \+ MIT license | Dev A |  |  |
| Skeleton deployed | Dev A |  |  |
| Env vars set in Vercel | Dev A |  |  |
| Contract \+ sport schema frozen | Both |  |  |
| Upload \+ validation | Dev A |  |  |
| Sport selector (3 sports) | Dev A |  |  |
| Loading state | Dev A |  |  |
| Result card (3 verdicts) | Dev A |  |  |
| Error states | Dev A |  |  |
| Sample clips (2 per sport) | Dev A |  |  |
| README \+ screenshot | Dev A |  |  |
| soccer.json verified | Dev B |  |  |
| football.json verified | Dev B |  |  |
| lacrosse.json verified | Dev B |  |  |
| Stage 1 observation working | Dev B |  |  |
| Retrieval working | Dev B |  |  |
| Stage 2 adjudication working | Dev B |  |  |
| Zod \+ code filtering | Dev B |  |  |
| No sport-specific branching | Dev B |  |  |
| Deployed, under timeout | Dev B |  |  |
| All 3 sports verified on live URL | Both |  |  |
| Backup demo recorded | Both |  |  |
| Pitch rehearsed | Both |  |  |

## **Definition of Done**

* It works on the deployed URL, not localhost.

* It handles its failure case without crashing.

* It is merged to main.

* The other person has seen it work.

## **Sync protocol — tighter than a weekend build**

| When | What |
| :---- | :---- |
| Every 45 minutes | Two-minute standup: did / doing / blocked |
| Every 45 minutes | Ask your harness to list every file it changed |
| Before any merge | Announce in chat, pull and rebase first |
| Blocked 10+ minutes | Say so immediately. In a six-hour sprint, 10 minutes is the threshold, not 20\. |

# **10\. Cut List — Decide Now, Not at Hour 5**

If you are behind schedule, cut in this order. Agreeing to this list in advance means you cut calmly instead of panicking.

| Order | Cut this | Keeps you compliant? |
| :---- | :---- | :---- |
| 1st | Officiating crew stretch goal | Yes — it was never required |
| 2nd | Mobile responsive polish | Yes |
| 3rd | Second sample clip per sport (drop to one each) | Yes |
| 4th | Lacrosse corpus — ship soccer \+ football, note lacrosse as in progress | Yes, but weakens differentiation |
| 5th | Original-call input — let the model infer the call | Yes, it is optional in the brief |
| NEVER | Deployment, rule-grounded reasoning, INCONCLUSIVE path, public repo | These are hard requirements |

**If you must cut a sport, cut lacrosse last-but-one — it is your differentiator. Cut it before you cut a working deployment, and never before you cut polish.**

# **11\. Decision Log**

| \# | Decision | Why | By |
| :---- | :---- | :---- | :---- |
| 1 | Three sports: soccer, football, lacrosse | Required scope; lacrosse differentiates | Both |
| 2 | Sport-as-data architecture, no code branching | Only way three sports fits in six hours | Both |
| 3 | Gemini native video, no frame extraction | Saves 2–3 hours we do not have | Both |
| 4 | Two-stage pipeline (observe → retrieve → adjudicate) | Structurally prevents rule hallucination | Both |
| 5 | 12–15 rules per sport, hard cap | Verification time is the bottleneck, not generation | Both |
| 6 |  |  |  |
| 7 |  |  |  |

# **12\. Known Limitations — Write These Now**

* Rule corpora are curated subsets (\~12–15 rules per sport) covering selected call types, not complete rulebooks.

* Single camera angle — occluded moments return INCONCLUSIVE rather than a guess.

* Retrieval is lexical/fuzzy, so an adjacent rule can occasionally surface over the ideal one.

* Football has the largest and most situational rulebook; coverage there is the thinnest of the three.

* Analysis takes 10–25 seconds — not real-time, not suitable for in-game use.

* Fast motion and low frame rates materially degrade accuracy, especially for lacrosse stick contact.

* No validation against actual league review outcomes.

* Built in a six-hour sprint — rule text was AI-drafted and human-spot-checked, not exhaustively audited.

*That last one is worth saying out loud in the pitch. Judges respect a team that knows exactly where its own weak points are.*

# **13\. Risk Register**

| Risk | Mitigation | Owner |
| :---- | :---- | :---- |
| Harness invents rule numbers | needsVerification flag \+ manual spot checks \+ server-side code filtering | Dev B |
| Two harnesses collide on the same files | Explicit ownership in every harness prompt; file-change audit every 45 min | Both |
| Serverless timeout kills analysis | Decided in minute 15: maxDuration=60 or Render | Both |
| Env var missing in production | Set in Vercel before any AI code is written | Dev A |
| Three sports becomes 3× the work | Sport-as-data architecture; no branching allowed | Both |
| Behind schedule at hour 4 | Pre-agreed cut list (Section 10\) | Both |
| Gemini rate limit during demo | Second API key ready; sample clips pre-warmed | Dev B |
| Venue wifi fails during pitch | Backup demo recorded at hour 5 | Both |

*One pipeline. Three JSON files. Ship at hour five, polish in the sixth.*
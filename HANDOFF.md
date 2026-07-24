# RefCheck AI — Dev A Handoff

> **Purpose of this file.** This is the single source of truth for picking up
> Dev A's frontend work in a **fresh context window or a different harness**.
> Read this top-to-bottom before touching anything. **Update it on every
> meaningful change** — see [How to keep this current](#how-to-keep-this-current).

**Last updated:** 2026-07-23 · **Branch:** `dev-a` · **Build:** ✅ `npm run build` passes · **QA:** ✅ all 4 states verified (desktop + mobile) · **A11y:** ✅ swept + reviewed · **Design:** ✅ premium dark revamp

---

## 1. TL;DR for a cold start

- **What this is:** RefCheck AI — upload a short sports clip, pick the sport,
  get an AI verdict ("was the ref's call fair?") cited against the rulebook.
- **6-hour hackathon, two devs.** I am **Dev A (frontend)**. Dev B owns the AI
  pipeline. We share one frozen contract and never edit each other's files.
- **Where the code lives:** the `dropref/` git repo (remote
  `github.com/dropdevco/dropref`). This `HANDOFF.md` sits at its root.
- **Current state:** full UI built and wired to **mock data**. Real endpoint
  exists but its `analyze()` is Dev B's stub. Everything typechecks + builds.
- **To run it:** `npm install && npm run dev` → http://localhost:3000. No API
  key needed while mocking.

---

## 2. Ownership map (do not cross these lines)

| Path | Owner | Rule |
| --- | --- | --- |
| `types/contract.ts` | **shared, FROZEN** | Never modify. Both halves build against it. |
| `app/page.tsx`, `components/**` | **Dev A** | My UI + state machine. |
| `lib/api-client.ts`, `lib/utils.ts`, `mocks/**` | **Dev A** | Client fetch, mocks, cn helper. |
| `app/layout.tsx`, `app/globals.css`, `public/**` | **Dev A** | Shell, theme tokens, assets. |
| `app/api/analyze/route.ts` | **Dev B** | Validation is done (Part 3). Don't touch the body beyond wiring. |
| `lib/ai/**`, `lib/rules/**`, `lib/sports.ts` | **Dev B** | Stubs that throw `NOT_IMPLEMENTED: Dev B`. Never edit. |
| `data/sports/*.json` | **Dev B** | Empty corpus shells. Never edit. |

**Hard constraints (from the brief):**
- No dependencies beyond: `@google/generative-ai`, `zod`, `fuse.js`,
  `lucide-react`, shadcn components (+ their radix/cva/clsx/tailwind-merge deps).
  **Ask before adding anything else.**
- Mobile-first. Judges open this on a phone.
- Adding a sport = one JSON file (Dev B) + one entry in the `SPORTS` array
  (`components/sports.ts`, Dev A). No other code changes.

---

## 3. How the frontend works

**State machine** lives in [`app/page.tsx`](app/page.tsx):
`idle → analyzing → result | error`, with a `reset()` back to `idle`.

**Mock wiring** — [`lib/api-client.ts`](lib/api-client.ts):
```ts
export const USE_MOCK = true;                          // one line to flip to the real API
const MOCK_SCENARIO = 'bad';                            // 'fair' | 'bad' | 'inconclusive' | 'error'
const MOCK_DELAY_MS = 12_000;                           // simulated latency for honest loading UI
```
- `analyzeClip(params)` → `Promise<AnalyzeResponse | AnalyzeError>`, never throws.
- `isAnalyzeError(result)` narrows the union for the page.
- **To exercise each UI state:** change `MOCK_SCENARIO` and reload. `'error'`
  drives the ERROR state; the other three drive RESULT.
- **Frontend-only verdict animation test:** the idle form has three "Animation
  test" buttons (Fair, Bad, Inconclusive) that run `analyzing -> result` against
  the existing mock fixtures without changing `MOCK_SCENARIO` or uploading a clip.

**Client-side validation** — [`components/clip.ts`](components/clip.ts):
20MB cap (matches the server), 15s duration cap (UI-only, read from a detached
`<video>` before upload), accepts mp4/mov/webm.

**Rulebook Lab (dev tool)** — [`/lab`](app/lab/page.tsx) + API
[`/api/rules-lab`](app/api/rules-lab/route.ts) + adjudicator
[`lib/lab/adjudicate.ts`](lib/lab/adjudicate.ts). Runs the decision pipeline on
a supplied description (skips the video step): **retrieve → adjudicate →
verdict**.
- RETRIEVE: `retrieveRules(getSport(sport), query, k)` → candidate shortlist
  (recall). Shown collapsed as "candidates considered", with matched keywords
  highlighted and long rule text truncated (`show full`).
- ADJUDICATE: Gemini (`@google/generative-ai`) picks the rule(s) that actually
  apply and returns an `AnalyzeResponse` (verdict + confidence + reasoning +
  cited rules) — same shape the app produces. **Requires `GEMINI_API_KEY`** in
  `.env.local`; without it the lab shows candidates only and says the verdict
  step is off. Optional `GEMINI_MODEL` env overrides the model (default
  `gemini-1.5-flash`).
This all lives under Dev-A paths (`app/lab`, `app/api/rules-lab`, `lib/lab`) and
**only imports** Dev B's `getSport`/`retrieveRules` — never edits `lib/ai/**`,
`lib/rules/**`, `lib/sports.ts`, or `data/**`. The lab's adjudicator is separate
from (and can later defer to) Dev B's real `lib/ai/pipeline.ts`. Curl-able:
`POST /api/rules-lab {sport, query, originalCall?, k?}`.

**Design language** (dark-only, "VAR booth at a night match"): tokens live in
`app/globals.css` (`:root`, no light theme). Fonts via `next/font` — Space
Grotesk (`font-display`) + Plus Jakarta Sans (`font-sans`). Referee cards
green/yellow/red are the semantic accent system (`--card-green/-yellow/-red`,
Tailwind `card_green/card_yellow/card_red`). Reusable: `.bezel` + `.bezel-core`
(double-bezel), `.eyebrow`, `.tabular`, `.text-glow-*`, and the whistle
keyframes (`anim-bob/-blow/-ring/-sheen`). `ease-smooth` = the house easing.
All motion is CSS + `tailwindcss-animate` (no Motion/GSAP — dep-free per constraint).

**Component inventory** (all under `components/`):
- `upload-zone.tsx` — drag-drop + file picker
- `sport-selector.tsx` — radio grid, driven by `SPORTS`
- `sample-clips.tsx` — 2 clips/sport, one-click load from `/public/samples`
- `analyzing-state.tsx` — staged copy on a `setInterval`, elapsed counter
- `result-view.tsx` — verdict badge, confidence meter, saw/reasoning, rules accordion
- `error-view.tsx` — distinct copy for all six `ErrorCode`s
- `verdict-badge.tsx` — the verdict as a tilted **referee card** (red/yellow/green)
- `confidence-meter.tsx` — confidence as a **slider gauge** with a glowing knob
- `whistle.tsx` — faux-3D metallic SVG whistle (idle bob / blowing + sound rings)
- `sports.ts` — **the single `SPORTS` source of truth** (labels, emoji, samples)
- `ui/` — shadcn primitives (button, accordion, card, badge)

---

## 4. Contract cheat-sheet (frozen)

`AnalyzeResponse`: `sport, verdict, confidence, playDescription, reasoning,
rulesCited[], originalCall, processingMs`.
`Verdict`: `FAIR_CALL | BAD_CALL | INCONCLUSIVE`.
`Confidence`: `HIGH | MEDIUM | LOW`.
`AnalyzeError`: `{ error, code }` where `ErrorCode` ∈ `FILE_TOO_LARGE |
BAD_FORMAT | MODEL_ERROR | TIMEOUT | RATE_LIMIT | UNSUPPORTED_SPORT`.

Full definitions: [`types/contract.ts`](types/contract.ts).

---

## 5. Roadmap — remaining Dev A work

Status legend: ☐ todo · ◐ in progress · ☑ done

- ☑ Scaffold (Next 14 App Router + TS + Tailwind + shadcn)
- ☑ Dev B stubs, wired route, mocks, full UI, clean build
- ☑ **Behavioral QA** — idle/analyzing/result/error + bad-format rejection all
  verified in-browser (375×812). App logic sound. _Pixel/visual review still
  pending: the browser pane wasn't compositing, so only DOM/behavior was checked._
- ☐ **Real sample clips** dropped into `/public/samples` (see that dir's README
  for exact filenames). `soccer-offside.mp4` is a **synthetic QA placeholder** —
  replace before demo. The other 5 sample buttons show "not available yet".
- ☑ **Polish & motion**: keyed entrance animations per phase, focus moves to the
  active view on transition, analyzing stage-label crossfade, verdict zoom-in,
  button/chip active-press. All `motion-safe:` + a global reduced-motion guard.
- ☑ **Favicon + OG/social meta** — `app/icon.svg` (whistle-ring + green check),
  `app/opengraph-image.png` (1200×630, rasterized locally, CSP-safe), and full
  OG + Twitter tags in `app/layout.tsx`. Verified emitted in the rendered `<head>`.
- ☑ **Accessibility sweep** — accessible names on dropzone/file-input/sample
  buttons, `aria-labelledby` on the sport radiogroup, `role="status"` sr-only
  verdict summary, `role="alert"` error, focus-visible on all custom controls,
  contrast fixed (rejection text now `red-600`/`red-400`, AA in both themes).
  Adversarially reviewed (Opus) — PASS.
- ☐ **Deploy** (Vercel) and fill the live link in `README.md`
- ☐ **Flip to real API** once Dev B lands `analyze()` — set `USE_MOCK = false`, smoke-test the multipart round-trip + each error code

_Adjust as we go — this list is the working plan, not a contract._

---

## 6. Commands

```bash
npm install          # deps
npm run dev          # local dev @ :3000
npm run build        # MUST stay green — proves Dev B can pull safely
npm run typecheck    # tsc --noEmit
```

---

## 7. How to keep this current

**Every time you (Claude or a dev) make a meaningful change, update this file
in the same commit.** Specifically:
1. Bump **Last updated** and the **Build** status line at the top.
2. Move the relevant roadmap item's checkbox (§5).
3. If you changed how something works, fix the description in §3.
4. Add a line to the changelog below.

### Changelog
- **2026-07-23** — Scaffolded project; Parts 1–4 complete (contract, Dev B
  stubs, wired route, full mock-driven UI). Build green. Created `dev-a` branch
  and this handoff doc.
- **2026-07-23** — Behavioral QA pass in-browser: idle → analyzing → result
  (bad) → reset, error state, and bad-format rejection all verified. Added a
  synthetic placeholder `public/samples/soccer-offside.mp4` so the flow is
  demoable. Known cosmetic gap: the 4th loading stage ("Comparing against
  official rules…", 16s+) never shows under the 12s mock — real pipeline
  latency will surface it.
- **2026-07-23** — Polish & motion pass (CSS/Tailwind + tailwindcss-animate,
  no new deps): per-phase entrance animation, focus management on view swap,
  stage-label crossfade, verdict zoom-in, active-press on buttons/chips, and a
  `prefers-reduced-motion` kill-switch in globals.css. Build green.
- **2026-07-23** — Orchestrated (Sonnet workers, Opus reviewer): (1) favicon +
  OG/Twitter metadata with a locally-rasterized 1200×630 PNG card; (2)
  accessibility sweep — accessible names, `aria-labelledby` sport group,
  sr-only `role="status"` verdict, `role="alert"` error, focus-visible on all
  custom controls, AA contrast fix on rejection text. Opus adversarial review
  PASS; build + typecheck green.
- **2026-07-23** — Premium dark UI revamp (frontend-studio skill). Dark-only
  "VAR booth" theme; Space Grotesk + Plus Jakarta Sans via next/font; referee
  card (green/yellow/red) accent system. New: faux-3D SVG whistle centerpiece
  (blows during analysis), sliding segmented sport control with custom sport
  glyphs, verdict-as-referee-card, confidence slider-gauge, double-bezel cards,
  desktop 2-column hero + form (collapses to 1 col on mobile). No new deps
  (motion is CSS + tailwindcss-animate). Verified all 4 states on desktop AND
  mobile in-browser (screenshots). Build + typecheck green, no warnings.
- **2026-07-23** — Added frontend-only verdict animation test controls: Fair,
  Bad, and Inconclusive buttons in the idle form now drive the normal analyzing
  transition and render the corresponding mock result fixture without a reload.
- **2026-07-23** — Desktop frontend layout pass: added a desktop-only replay
  desk plus sticky controls rail, kept the mobile stacked flow intact, widened
  analyzing/result containers, and split the result view into a desktop grid.
- **2026-07-23** — Fixed portrait/vertical clip rendering by giving preview,
  analyzing, and result playback responsive video frames and fitting media with
  `object-contain` inside the frame instead of sizing from width and clipping.
- **2026-07-23** — Implemented the `getSport` loader in `lib/sports.ts` and structured/populated rules corpora for Soccer, Football, and Lacrosse under `data/sports/` based on the approved AI-friendly schema. Verified files and build.
- **2026-07-23** — Implemented `retrieveRules` in `lib/rules/retrieve.ts` using Fuse.js with custom weights. Updated `data/sports/soccer.json` to include the exact detailed text and criteria for Law 11 (Offside Position, Offence, No Offence, Offences and Sanctions) as requested. Verification script and build passed.
- **2026-07-23** — Updated `data/sports/soccer.json` Law 12 rules (Direct Free Kick Fouls, Handling the Ball, and Indirect Free Kick) with the exact detailed rules, criteria, and exceptions provided. Build and verification checks passed.



- **2026-07-23** — Added the **Rulebook Lab** dev tool (`/lab` + `/api/rules-lab`)
  to test the `description → rulebook` retrieval step in isolation, without a
  clip or GEMINI key. Imports Dev B's `getSport`/`retrieveRules` only — no edits
  to `lib/**` or `data/**`. Verified live across all three sports; build + typecheck green.
- **2026-07-23** — Rulebook Lab upgraded to a full decision pipeline
  (retrieve → adjudicate → verdict). Added `lib/lab/adjudicate.ts` (Gemini,
  gated on `GEMINI_API_KEY`) so the lab returns an `AnalyzeResponse` verdict that
  cites only the applicable rule(s); retrieval candidates are collapsed as
  "considered" and long rule text truncates with `show full`. Still Dev-A-only
  files; no edits to `lib/ai/**` or `data/**`. Build + typecheck green;
  no-key path verified live (verdict path needs a key).
- **2026-07-23** — Lab adjudicator model resiliency: don't hardcode/trust
  ListModels. Try `gemini-flash-latest` → `gemini-2.0-flash` → `gemini-2.0-flash-001`,
  falling through on BOTH 404 (retired model) AND 429 (a pinned version can be
  quota-capped at 0 while the `-latest` alias has quota). Caches the first
  working model; `GEMINI_MODEL` still overrides; quota/auth errors get a concise
  UI message. Verified live: offside example → BAD_CALL citing only Law 11.2.
- **2026-07-23** — Retrieval quality fix (⚠️ Dev A edited **Dev B files** at the
  owner's explicit request — flagging for Dev B awareness / merge):
  - `lib/rules/retrieve.ts` — tokenised retrieval. Long natural-language
    descriptions scored poorly as one Fuse pattern against short keywords, so
    the applicable rule (e.g. `Law 12.1.F`) dropped below threshold. Now searches
    the whole query **plus each significant term**, summing per-rule relevance;
    threshold 0.6→0.5, `ignoreLocation:true`. Same signature/weights.
  - `data/sports/soccer.json` — added plain-language keywords to `Law 12.1.F`
    (slide, from behind, ankle, challenge, lunge, caught, before the ball…).
  - `lib/ai/prompts.ts` — implemented `observationPrompt` (was a stub): a
    corpus-driven template that makes the model describe plays in officiating
    vocabulary so descriptions are retrievable. (`adjudicationPrompt` still stub.)
  Verified: foul/offside/handball/lacrosse queries now retrieve the correct rule
  as a top candidate, no regressions. Live verdict for the foul case pending —
  the key's daily free-tier quota (gemini-3.6-flash) was exhausted by testing;
  the retrieval half is deterministic and confirmed.
- **2026-07-23** — Lab adjudication now supports **OpenRouter** (OpenAI-compatible,
  called via `fetch` — no new dep) and prefers it when `OPENROUTER_API_KEY` is
  set, falling back to the Gemini SDK otherwise. Default OpenRouter model
  `google/gemini-2.5-flash` (falls back to `openai/gpt-4o-mini`); override with
  `OPENROUTER_MODEL`. Note: gpt-4o-mini mis-ruled the nuanced offside "level =
  onside" case (FAIR instead of BAD); gemini-2.5-flash gets it right — model
  choice affects accuracy on subtle rules. Verified live end-to-end: foul case →
  BAD_CALL citing Law 12.1.F; offside → BAD_CALL citing Law 11.1. `.env.example`
  documents both providers.
- **2026-07-23** — Lab adjudication is now two-mode:
  - **verdict mode** (a referee call was given) → FAIR/BAD/INCONCLUSIVE, as before;
  - **ruling mode** (no call given) → the AI makes the call itself and returns a
    `decision` (e.g. "Direct free kick — foul", "Send off — serious foul play")
    plus a `severity` (no-offence / infringement / caution / dismissal). The lab
    renders ruling severity as referee cards (yellow = caution, red = dismissal),
    whistle/flag for infringement, green check for no-offence.
  Lab-only (the frozen `AnalyzeResponse` can't express a self-ruling) — the route
  now returns `result: LabResult` (discriminated by `mode`). Verified live:
  ruling "studs-up lunge" → "Send off — serious foul play" (dismissal, red card).

# RefCheck AI — Dev A Handoff

> **Purpose of this file.** This is the single source of truth for picking up
> Dev A's frontend work in a **fresh context window or a different harness**.
> Read this top-to-bottom before touching anything. **Update it on every
> meaningful change** — see [How to keep this current](#how-to-keep-this-current).

**Last updated:** 2026-07-28 · **Branch:** `dev-a` · **Build:** ✅ `npm run build` passes · **QA:** ✅ all 4 states verified (desktop + mobile) · **A11y:** ✅ swept + reviewed · **Design:** ✅ premium dark revamp + WebGL mist + product tour

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
| `types/contract.ts` | **shared, FROZEN** | Never modify EXISTING fields. Both halves build against it. New capabilities may only ADD optional fields — see the graph block at the bottom of `AnalyzeResponse`. |
| `app/page.tsx`, `components/**` | **Dev A** | My UI + state machine. |
| `lib/api-client.ts`, `lib/utils.ts`, `mocks/**` | **Dev A** | Client fetch, mocks, cn helper. |
| `app/layout.tsx`, `app/globals.css`, `public/**` | **Dev A** | Shell, theme tokens, assets. |
| `app/api/analyze/route.ts` | **Dev B** | Validation is done (Part 3). Don't touch the body beyond wiring. |
| `lib/ai/**`, `lib/rules/**`, `lib/sports.ts` | **Dev B** | Stubs that throw `NOT_IMPLEMENTED: Dev B`. Never edit. |
| `backend/graph/**` | **Dev B** | The analysis graph. Owns the observation stage, the evidence auditor, the reliability composition and the human gate. |
| `backend/council/**`, `backend/eval/**` | **Dev B** | Adjudication sub-graph and the accuracy harness. |
| `data/sports/*.json` | **Dev B** | Empty corpus shells. Never edit. |

**Hard constraints (from the brief):**
- No dependencies beyond: `@google/generative-ai`, `zod`, `fuse.js`,
  `lucide-react`, shadcn components (+ their radix/cva/clsx/tailwind-merge deps).
  **Ask before adding anything else.**
- Mobile-first. Judges open this on a phone.
- Adding a sport = one JSON file (Dev B) + one entry in the `SPORTS` array
  (`components/sports.ts`, Dev A). No other code changes.

---

## 2b. The analysis graph (what `/api/analyze` now runs)

`POST /api/analyze` no longer calls the single-shot `runAnalysisPipeline`. It
calls `runAnalysisGraph` in [`backend/graph/run.ts`](backend/graph/run.ts):

```
CV pre-pass ─┬─> observer A (raw clip) ──┐
             └─> observer B (CV render) ─┴─> reconciler ─> retrieval
                                                              │
                          3 seats ─> [debate] ─> [chair] ──────┘
                                          │
                              evidence auditor ─> score ─> human gate
```

Two things changed that the frontend can see:

1. **Verdicts can be HELD.** When `needsHumanReview` is `true`, the system does
   not stand behind the verdict — it fired the human gate because reliability
   fell below the bar, the auditor did not run, the observers could not be
   reconciled, or the auditor found the verdict claims more than the evidence
   supports. `reviewReasons` says which, in plain language.
   **Dev A: this is not yet rendered.** The API ships it; the UI currently shows
   a held verdict exactly like any other, which is the one thing this whole
   change exists to stop. A `needs_review` variant of the RESULT state is the
   outstanding frontend work.
2. **New optional fields on `AnalyzeResponse`**, all additive, all safe to
   ignore: `runId`, `reliability`, `reliabilityScore`, `accuracyScore`,
   `needsHumanReview`, `reviewReasons`, `contested`, `stage`, `panel`.
   `contested` is the list of facts the two observers disagreed about, and
   `panel` is the seat-by-seat spread — both exist so dissent can be shown
   rather than hidden behind a single confident verdict.

Every run writes `backend/runs/<runId>/` (gitignored): one JSON artifact per
node, plus a `review-queue/` entry when the gate fires. Writes are best-effort
and never fail a request.

Config lives in `.env.example` under "Analysis graph". Tests: `npm run test:graph`.

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
20MB cap (matches the server), 18s duration cap (UI-only, read from a detached
`<video>` before upload), accepts mp4/mov/webm.
Uploaded clips open in an editor before analysis. Crop mode exposes a
PowerPoint-style crop box with edge/corner handles; Zoom mode uses the same crop
region but lets users drag it and pinch/wheel to zoom. Users must click **Set
this video** to export the current edit to a cropped WebM via `lib/video-crop.ts`;
only that set WebM is sent to `/api/analyze`.

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
- `video-cropper.tsx` — canvas preview + Crop/Zoom modes for preparing the
  submitted video
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
- **2026-07-23** — Added a 250ms duration metadata tolerance so browser-reported
  `15.0s` clips do not get rejected due to tiny container/metadata drift.
- **2026-07-23** — Raised the frontend-only clip duration guard from 15s to 18s
  while keeping the 250ms metadata tolerance.
- **2026-07-23** — Removed `next/font/google` so local dev/build no longer
  depends on downloading Google Fonts; CSS variables now provide local system
  font stacks for `font-sans` and `font-display`.
- **2026-07-23** — Removed the main-screen sample/mock verdict testing panel
  and added client-side crop before submit. The API now receives a cropped WebM
  generated from the exact crop rectangle the user previews.
- **2026-07-23** — Reworked crop UX into a PowerPoint-style crop box: users drag
  the selected region or pull edge/corner handles, with no Wide/Square/Tall
  presets and no pan sliders.
- **2026-07-23** — Split video editing into explicit Crop and Zoom modes and
  added a required "Set this video" step. Editing invalidates the previously set
  file, and analysis only sends the generated edited WebM.
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
- **2026-07-23** - Main `/api/analyze` now also prefers **OpenRouter** when
  `OPENROUTER_API_KEY` is set. Uploaded clips are sent as base64 data URLs with
  OpenRouter's `video_url` content type, so `OPENROUTER_VIDEO_MODEL` must point
  to a video-capable model. Default is `google/gemini-2.5-flash`; Gemini SDK is
  only the fallback when `OPENROUTER_API_KEY` is absent. `.env.example` was
  updated to make OpenRouter the primary setup path.
- **2026-07-24** — Video-editor UX fixes (orchestrated: 2 Sonnet workers + Opus
  adversarial review). (1) Clip now autoplays instead of showing a black frame;
  (2) crop/zoom UI only appears after the user activates a tool (`EditMode` gained
  a `'none'` default); (3) "Set video" is only required when crop/zoom actually
  changed — `DEFAULT_VIDEO_CROP` is now the full frame and `isDefaultCrop()` gates
  it, unedited clips analyze the original file; (4) removed the
  "Soccer · Football · Lacrosse" eyebrow (both mobile + desktop layouts);
  (5) zoom-out root cause fixed — the canvas preview (`drawCropEditorFrame`) and
  its `strokeRect` were deleted, so the crop border is now a single DOM overlay in
  one coordinate space instead of two disagreeing ones; the real `<video>` is the
  paint surface.
  Opus review caught a regression worth remembering: **skipping the crop step also
  skips the only downscale**, so `onAnalyze` now transcodes clips over
  `MAX_DIRECT_UPLOAD_BYTES` (8MB) transparently — the server base64-inflates
  uploads ~1.37x and the model rejects oversized inline payloads.
  Build + typecheck green. Autoplay could not be visually confirmed (the browser
  pane wasn't compositing, so Chrome suppressed playback); verified by DOM state.
- **2026-07-24** — UI polish round: (a) removed the focus ring from the stage
  `<section>` — it is `tabIndex={-1}` and React StrictMode's double-fired mount
  effect focused it on load, painting a green frame around the whole page;
  (b) footer now credits the real corpora (IFAB / NFL / NCAA Men's Lacrosse)
  instead of disclaiming official rulings; (c) new **referee mark** — the user's
  line-art PNG recoloured to the palette via PIL into `public/referee.png`
  (light lines) and `app/icon.png` (navy rounded square + green ring favicon,
  replacing `app/icon.svg`), surfaced through `components/referee-mark.tsx` in
  the header and the two static whistle slots (the *animated* whistle stays in
  the analyzing state); (d) "Set this video" now shows
  `components/set-video-progress.tsx` — a DETERMINATE bar driven by a real
  `onProgress` callback added to `cropVideoFile` (it plays the clip in real time,
  so `currentTime/duration` is honest progress) with staged labels, replacing the
  static "Setting video...". Build + typecheck green.
- **2026-07-24** — **Duration trimming** (new feature). Users upload a whole
  recording and drag the ends of a timeline to select the exact play; only that
  span is encoded and sent to the AI.
  - `components/video-trimmer.tsx` — the timeline: draggable in/out handles,
    draggable window, playhead, live "Ns selected", dimmed unselected regions.
    Handles are `role="slider"` with arrow-key nudging. Clamps to
    `MIN_SELECTION_S`..`MAX_SELECTION_S`. NOTE: relative moves accumulate off a
    `trimRef`, not render state — reading `trim` from the closure made rapid
    key-repeat nudges overwrite each other (all computing from one stale value).
  - `lib/video-crop.ts` — `VideoTrim`, `isFullTrim()`, and `cropVideoFile` now
    takes an options object `{ trim, onProgress }`. It seeks to the in-point
    before `recorder.start()` and stops capture once the playhead passes the
    out-point (guarded by `hasOutPoint` so an unknown duration still falls back
    to `ended`). Progress is measured across the SELECTION, not the source.
  - `components/clip.ts` — limits restructured: `MAX_SOURCE_BYTES` 150MB and
    `MAX_SOURCE_DURATION_S` 5min (was a flat 20MB/18s upload cap), with
    `MAX_SELECTION_S` 18 as the analysable window. Rationale: the encoder runs in
    real time and always downscales to 960p/30fps, so only the *selection* costs
    time and payload — a big source only costs browser memory/scrubbing feel.
  - `app/page.tsx` — `trim`/`sourceDuration` state; `hasEdits` now includes
    `!isFullTrim(...)`, so anything longer than 18s must be encoded before
    analysis (it physically cannot be sent whole). Upload/error copy updated.
  Build + typecheck green. Trimmer UI verified in-browser (seeding, accumulation,
  min-selection clamp, edit gating).
- **2026-07-28** — Four features, orchestrated (3 parallel Opus workers + Opus
  adversarial reviewer, then a fix pass). **No new dependencies** in any of them.
  1. **WebGL mist background** — `components/mist-background.tsx`, mounted in
     `app/layout.tsx`. Hand-rolled domain-warped fbm shader over Ashima 3D
     simplex, two fog decks with aerial-perspective dimming, ~6.2KB gzip. Chosen
     over `@paper-design/shaders-react` (no fog primitive, 822KB unpacked,
     pre-1.0) and React Bits (MIT + Commons Clause — not permissive). The
     backdrop is now three planes: `body::before` (-3) → `.mist-layer` (-2) →
     `body::after` grid (-1), so the pitch-line grid reads as glass in FRONT of
     the fog. 30fps cap, DPR capped 1.5, 0.55 render scale, adaptive degrade,
     parks on `document.hidden`, static frame under `prefers-reduced-motion`,
     silent CSS-gradient fallback with no WebGL.
  2. **First-visit product tour** — `components/tour/{product-tour,tour-steps}.tsx`,
     8 steps, `localStorage` key `refcheck.tour.v1` (versioned; bump to re-run
     for everyone). Hand-rolled rather than driver.js/joyride because **no tour
     library blurs the backdrop** — they dim with an SVG cutout. The blur is four
     `backdrop-filter` panels tiled AROUND the target rect, so the target is
     never behind a blurring surface. Persistent "Replay the tutorial" control.
     ⚠️ `app/page.tsx` renders the idle screen TWICE (desktop `lg:grid` + mobile
     `lg:hidden`), so every anchor exists twice; `resolveVisibleTarget()` scores
     by rect area (hard `continue` on zero) with `offsetParent` only as a
     tie-breaker — the tie-breaker matters because the replay button is
     `position: fixed`, where `offsetParent` is always null.
  3. **Official rulebook links on all 39 rules** — `RuleSource {url, publisher,
     label}` in `types/contract.ts`; `SportRule.source` required,
     `CitedRule.source` optional. Every URL fetched and verified 200; IFAB
     anchors confirmed in served HTML; NFL anchors land on the right Rule
     headings; NCAA is the 2025-26 PDF with per-rule `#page=`. `backend/sports.ts`
     now **zod-validates the corpus at load** — it was a bare `JSON.parse` cast,
     so a missing `source` produced zero tsc errors and shipped a link-less
     citation silently. Now throws naming the exact rule.
  4. **Video playback manipulation** — `components/video-cropper.tsx` +
     `video-trimmer.tsx`. Grab-and-hold the stage to pause and jog-scrub, pinch
     to scrub on touch, horizontal wheel to scrub, draggable playhead on the
     timeline (implements the `onScrub` prop that had been declared but never
     wired), frame stepping, 0.25×/0.5×/1× rate chips, J/K/L + arrows + Space
     transport. Crop handles and zoom pinch are untouched when their tool is
     active; stage gestures are inert unless `mode === 'none'`.

  **Fixes from the adversarial review (all verified live):**
  - 🔴 **The mist rendered nothing at all in dev.** `bail()` called
    `WEBGL_lose_context.loseContext()` during StrictMode's teardown, but React
    reuses the same `<canvas>` and `getContext()` always returns the SAME object
    — so the remount got a dead context, shaders failed to compile, and it
    bailed again. `bail()` also never reset `glReady`, leaving `data-gl="true"`
    on both children, which hid the CSS fallback too. Removed `loseContext()`,
    added `setGlReady(false)` to `bail()`, and `startLoop()` now refuses to spin
    on a lost context.
  - 🟠 **Tour focus trap leaked on the first Shift+Tab.** The tour opens focused
    on the dialog container (`tabIndex={-1}`), which is `inside` but neither
    `first` nor `last`, so the shift branch didn't fire and native traversal
    walked backwards out of the `aria-modal` dialog onto the replay button.
  - 🟠 **Loop guard re-armed mid-grab.** The stage is `tabIndex={0}` and
    pointer-down focuses it, so Space during a grab hit `togglePlayback` →
    `resumeLoopGuard()`, killing jog scrubbing and leaving a paused clip playing
    on release. `stageKeys` now returns early while `grabRef` is live.
  - 🟡 `href` scheme allow-list on rulebook links (`lib/api-client.ts` does no
    runtime validation of the response body); spotlight no longer trails its
    target during scroll (`data-tracking` suppresses the 460ms geometry easing
    while tracking); corrected the shader's contrast comment (real worst case is
    ~6.1:1 muted-fg, not >6.5:1 — still well clear of AA); footer contrast fixed
    (`text-muted-foreground/70` measured 4.04:1, already under AA before mist).

  **Known gaps, deliberately left:** NCAA lacrosse rule *codes* in the corpus are
  from an older edition and no longer match the 2025-26 book (Unnecessary
  Roughness is 5-5 not 5-11; Cross-Check 5-11 not 5-4; Offside 4-12 not 4-10) —
  links point at the correct content, matched by subject, but the displayed codes
  are stale. NFL deep links use React-generated `AccordionStack-N` ids that are
  index-based and will shift if that page's component order changes (degrades to
  the top of the correct rulebook, never a 404). Page behind the tour is not
  `inert`/`aria-hidden` (focus trap holds; SR virtual cursor can still browse).
  `webglcontextrestored` is unhandled, so the mist cannot recover from a real GPU
  context loss.

- **2026-07-28** — Tour steps 3-5 now teach against a real editor instead of a
  blank screen. `components/tour/tour-demo-editor.tsx` is a non-functional
  stand-in (stage with crop box + eight handles + scrub HUD, the **real**
  `VideoTrimmer` driven by demo props, crop/zoom row, transport row, rate chips)
  that `app/page.tsx` mounts in the editor's slot while the tour is on a step
  with `needsEditorDemo`. Previously "Trim to the moment", "Work the playhead"
  and "Reframe the play" had no anchor on a first visit — the editor does not
  exist until a clip is loaded — so they degraded to unanchored centred cards
  and described controls the reader could not see.
  - Wiring: `TourStep.needsEditorDemo` → `ProductTour({ onEditorDemoChange })`
    → `tourEditorDemo` state in `app/page.tsx`. The page owns the decision
    because only it knows whether a real clip is loaded; with one, the real
    `VideoCropper` is on screen and gets spotlighted instead. The two are
    mutually exclusive, so the shared `data-tour` anchors can never collide.
  - The demo reuses the actual `VideoTrimmer` (pure, prop-driven) rather than a
    lookalike, so it cannot drift from the control it teaches. Passing no
    `onScrub` is what renders its playhead inert.
  - Inert by construction: `aria-hidden` (announcing fake buttons is worse than
    silence — the card carries the teaching), `pointer-events-none`, and
    `tabIndex={-1}` on every control.
  - ⚠️ Ordering fix in `product-tour.tsx`: the demo is mounted by the page in
    response to the tour's own effect, so its anchor lands one commit AFTER the
    step's `measure()`. Added a `setTimeout(measure, 0)` alongside the rAF
    follow loop — the loop would eventually catch it, but that made a correct
    spotlight depend on winning a frame race.
  Verified in-browser at 1280px and 375px: all 8 steps anchor correctly (03→trim,
  04→stage, 05→crop-zoom), the demo mounts and unmounts on exactly those steps,
  the card stays in the viewport, and nothing leaks after the tour closes.

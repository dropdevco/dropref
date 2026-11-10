# RefCheck AI

AI-powered instant replay: upload a short clip, pick the sport, and get a verdict on whether the referee's call was fair, cited against the official rulebook. Supports soccer (IFAB), football (NFL) and men's lacrosse (NCAA).

**Live:** _<!-- TODO: add deployment URL -->_

---

## Setup

```bash
npm install
cp .env.example .env      # then fill in OPENROUTER_API_KEY
npm run dev               # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run build` / `npm run typecheck` / `npm run lint` | Build, type-check, lint |
| `npm run test:graph` | Analysis graph mechanism tests |
| `npm run test:council` | Council (panel / debate / chair) tests |
| `npm run test:eval` | Eval metrics tests |
| `npm run eval` | Accuracy and cost harness against `backend/eval/golden/` |

Optional SAM / CV tools — off by default. They need a local Python service and a lot of RAM,
so they are only set up on some machines; everything else works without them.

```bash
npm run dev       # without SAM (any machine)
npm run dev:sam   # with SAM: shows the Advanced Tracking Layer, /sam-test and /cv-test
```

`dev:sam` expects a service at `http://127.0.0.1:8000` (override with `NEXT_PUBLIC_SAM_SERVICE_URL`)
and warns at startup if nothing is answering. Two different services use that port, so run one at a time:
`../sam-service` (SAM 2 masks for the Advanced Tracking Layer, not in this repo) or `cv_service/`
(`/track`, used by `/api/analyze`; if it's not running the analysis just uses the raw video):

```bash
cd cv_service && pip install -r requirements.txt && uvicorn main:app --port 8000
```

### Mock mode

The app calls the real `/api/analyze` (`USE_MOCK = false` in [`lib/api-client.ts`](lib/api-client.ts)).
Set it to `true` to run the UI against the fixtures in `mocks/`; `MOCK_SCENARIO` picks which one.

---

## Architecture

| Path | Purpose |
| --- | --- |
| `types/contract.ts` | Shared request/response contract. Existing fields are frozen; new ones may only be added as optional. |
| `app/`, `components/`, `lib/` | Next.js UI, client state machine, video editor, API client. |
| `app/api/analyze/route.ts` | Upload validation (type and size), optional CV pre-pass, then runs the graph. |
| `backend/graph/` | The analysis graph, described below. |
| `backend/council/` | Multi-model adjudication: panel, debate, chair. |
| `backend/eval/` | Accuracy and cost harness with golden sets per sport. |
| `backend/rules/`, `backend/sports.ts`, `backend/data/sports/*.json` | Rule retrieval and the zod-validated rulebook corpus. |
| `cv_service/` | Optional Python/FastAPI tracking service. |

Adding a sport is one corpus JSON file plus one entry in `components/sports.ts`.

## AI pipeline

`POST /api/analyze` runs the graph in `backend/graph/run.ts`:

```
CV pre-pass ─┬─> observer A (raw clip) ──┐
             └─> observer B (CV render) ─┴─> reconciler ─> retrieval
                                                              │
                          3 seats ─> [debate] ─> [chair] ──────┘
                                          │
                              evidence auditor ─> score ─> human gate
```

When reliability is too low, the auditor finds the verdict overreaches its evidence, or the observers cannot be reconciled, the human gate **holds** the verdict. The response then has `needsHumanReview: true` and `reviewReasons`, and the UI shows it as provisional rather than as a confirmed result. Every run writes per-node artifacts to `backend/runs/<runId>/` (gitignored).

See [`HANDOFF.md`](HANDOFF.md) for the full working notes and changelog.

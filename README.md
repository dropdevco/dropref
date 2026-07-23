# RefCheck AI

AI-powered instant replay: upload a short clip, pick the sport, and get a verdict on whether the referee's call was fair — cited against the official rulebook.

**Live:** _<!-- TODO: add deployment URL -->_

---

## Setup

```bash
npm install
cp .env.example .env      # then fill in GEMINI_API_KEY
npm run dev               # http://localhost:3000
```

Build & typecheck:

```bash
npm run build
npm run typecheck
```

### Frontend mock mode

The UI ships wired to mock data so it runs with zero backend. Toggle it in
[`lib/api-client.ts`](lib/api-client.ts):

```ts
export const USE_MOCK = true;   // flip to false to hit /api/analyze
```

While mocking, pick which fixture is returned with `MOCK_SCENARIO`
(`'fair' | 'bad' | 'inconclusive' | 'error'`) at the top of the same file.

---

## Architecture

| Path | Owner | Purpose |
| --- | --- | --- |
| `types/contract.ts` | shared (frozen) | The request/response contract both halves build against. Do not modify. |
| `app/page.tsx`, `components/**` | Dev A (frontend) | UI, state machine, client-side validation. |
| `lib/api-client.ts`, `mocks/**` | Dev A (frontend) | Client fetch + mock fixtures. |
| `app/api/analyze/route.ts` | Dev B (pipeline) | Request validation (done) + `analyze()` call. |
| `lib/ai/**`, `lib/rules/**`, `lib/sports.ts` | Dev B (pipeline) | Gemini pipeline, rule retrieval, corpus loading. |
| `data/sports/*.json` | Dev B (pipeline) | Per-sport rulebook corpus. |

Adding a sport is meant to be **one JSON file + one line** in the frontend
`SPORTS` array — no other code changes.

---

## AI Pipeline

_<!-- Dev B: document the two-stage Gemini pipeline here. -->_

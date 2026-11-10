// Optional local SAM / CV service. Most machines don't have it installed, so
// it is OFF unless explicitly enabled. Use `npm run dev` (off) or
// `npm run dev:sam` (on) — see scripts/dev.mjs.
//
// These must stay literal `process.env.NEXT_PUBLIC_*` reads so Next.js can
// inline them into the client bundle.
export const SAM_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SAM === 'true';

export const SAM_SERVICE_URL = (
  process.env.NEXT_PUBLIC_SAM_SERVICE_URL || 'http://127.0.0.1:8000'
).replace(/\/+$/, '');

export function samUrl(path: string): string {
  return `${SAM_SERVICE_URL}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Turns a network failure into a message that says what to do. */
export function samErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof TypeError) {
    return `Can't reach the SAM service at ${SAM_SERVICE_URL}. Start it, or run the app without SAM (npm run dev).`;
  }
  return err instanceof Error && err.message ? err.message : fallback;
}

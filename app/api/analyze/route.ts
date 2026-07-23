import { NextResponse } from 'next/server';
import { z } from 'zod';

import { analyze } from '@/lib/ai/pipeline';
import type {
  AnalyzeError,
  AnalyzeResponse,
  ErrorCode,
  SportId,
} from '@/types/contract';

export const maxDuration = 60;
export const runtime = 'nodejs';

/**
 * POST /api/analyze  (multipart/form-data)
 *   - video:        File     (required)   the clip to analyze
 *   - sport:        SportId  (required)   'soccer' | 'football' | 'lacrosse'
 *   - originalCall: string   (optional)   what the ref called on the field
 *
 * Request validation below is REAL and owned jointly with the contract.
 * The `analyze()` call is Dev B's — its body currently throws NOT_IMPLEMENTED.
 * Dev B: implement the pipeline, not this handler's validation/wiring.
 */

const MAX_BYTES = 20 * 1024 * 1024; // 20MB
const SPORT_IDS = ['soccer', 'football', 'lacrosse'] as const;

/** Build a typed error response with an appropriate HTTP status. */
function fail(code: ErrorCode, message: string, status: number) {
  const body: AnalyzeError = { error: message, code };
  return NextResponse.json(body, { status });
}

const fieldsSchema = z.object({
  sport: z.enum(SPORT_IDS, {
    errorMap: () => ({ message: 'Unsupported or missing sport.' }),
  }),
  originalCall: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail('BAD_FORMAT', 'Request must be multipart/form-data.', 400);
  }

  // --- sport + originalCall ------------------------------------------------
  const parsed = fieldsSchema.safeParse({
    sport: form.get('sport'),
    originalCall: form.get('originalCall') ?? undefined,
  });
  if (!parsed.success) {
    return fail('UNSUPPORTED_SPORT', 'Unsupported or missing sport.', 400);
  }
  const sport = parsed.data.sport as SportId;
  const originalCall = parsed.data.originalCall ?? null;

  // --- video file ----------------------------------------------------------
  const video = form.get('video');
  if (!(video instanceof File) || video.size === 0) {
    return fail('BAD_FORMAT', 'A video file is required.', 400);
  }
  if (!video.type.startsWith('video/')) {
    return fail('BAD_FORMAT', 'Uploaded file must be a video.', 415);
  }
  if (video.size > MAX_BYTES) {
    return fail('FILE_TOO_LARGE', 'Video must be 20MB or smaller.', 413);
  }

  // --- run the pipeline (Dev B) -------------------------------------------
  try {
    const result: AnalyzeResponse = await analyze(video, sport, originalCall);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Analysis failed unexpectedly.';
    return fail('MODEL_ERROR', message, 500);
  }
}

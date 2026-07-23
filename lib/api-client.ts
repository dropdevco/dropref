import type {
  AnalyzeError,
  AnalyzeResponse,
  SportId,
} from '@/types/contract';

import fairCall from '@/mocks/fair-call.json';
import badCall from '@/mocks/bad-call.json';
import inconclusive from '@/mocks/inconclusive.json';
import errorMock from '@/mocks/error.json';

/**
 * OWNER: Dev A (frontend).
 *
 * Flip this ONE line to switch the whole UI between mock data and the real
 * /api/analyze endpoint. Everything else stays the same.
 */
export const USE_MOCK = true;

/**
 * While USE_MOCK is true, choose which fixture `analyzeClip()` returns so the
 * IDLE → ANALYZING → RESULT/ERROR states can each be built honestly.
 */
const MOCK_SCENARIO: 'fair' | 'bad' | 'inconclusive' | 'error' = 'bad';

/** Simulated latency (ms) while mocking, so the loading state is real work. */
const MOCK_DELAY_MS = 12_000;

const MOCKS: {
  fair: AnalyzeResponse;
  bad: AnalyzeResponse;
  inconclusive: AnalyzeResponse;
  error: AnalyzeError;
} = {
  fair: fairCall as AnalyzeResponse,
  bad: badCall as AnalyzeResponse,
  inconclusive: inconclusive as AnalyzeResponse,
  error: errorMock as AnalyzeError,
};

export interface AnalyzeClipParams {
  video: File;
  sport: SportId;
  originalCall: string | null;
}

/** Narrowing helper for callers. */
export function isAnalyzeError(
  result: AnalyzeResponse | AnalyzeError,
): result is AnalyzeError {
  return 'code' in result && 'error' in result;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Analyze a clip. Returns mock data while USE_MOCK is true, otherwise POSTs
 * multipart/form-data to /api/analyze. Always resolves to a contract-shaped
 * value (never throws) so the UI can render an error state instead.
 */
export async function analyzeClip(
  params: AnalyzeClipParams,
): Promise<AnalyzeResponse | AnalyzeError> {
  if (USE_MOCK) {
    await sleep(MOCK_DELAY_MS);
    return MOCKS[MOCK_SCENARIO];
  }

  try {
    const body = new FormData();
    body.append('video', params.video);
    body.append('sport', params.sport);
    if (params.originalCall) {
      body.append('originalCall', params.originalCall);
    }

    const res = await fetch('/api/analyze', { method: 'POST', body });
    const data = (await res.json()) as AnalyzeResponse | AnalyzeError;
    return data;
  } catch {
    const fallback: AnalyzeError = {
      error: 'Could not reach the analysis service. Check your connection.',
      code: 'MODEL_ERROR',
    };
    return fallback;
  }
}

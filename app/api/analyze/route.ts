import { NextResponse } from 'next/server';
import { runAnalysisGraph } from '../../../backend/graph/run';
import { SportId } from '../../../types/contract';

/**
 * Must exceed the graph's own budget, or the platform kills the request before
 * the graph's deadlines can fire and degrade gracefully. The graph spends up to
 * GRAPH_OBSERVE_TIMEOUT_MS (60s) on observation, then COUNCIL_TIMEOUT_MS (90s)
 * on the panel and debate, then COUNCIL_CHAIR_TIMEOUT_MS (30s) on the chair and
 * GRAPH_AUDIT_TIMEOUT_MS (20s) on the audit — each on its own clock.
 *
 * At 60s this route used to abort mid-council, which looked identical to a
 * genuine settle: exactly the failure the chair's dedicated deadline was added
 * to prevent, reintroduced one layer up. Lower the GRAPH_ and COUNCIL_ budgets
 * if your host caps duration below this.
 */
export const maxDuration = 300;
export const runtime = 'nodejs';

/**
 * Server-side upload ceiling. The client transcodes every analysable clip to a
 * small WebM (it re-encodes anything over 8MB), so a legitimate request is far
 * below this; the cap exists so a direct caller cannot make us base64-inflate
 * an arbitrarily large body. Override with MAX_UPLOAD_MB.
 */
const MAX_UPLOAD_BYTES =
  (Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 25) *
  1024 *
  1024;
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];

function errorJson(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const sport = formData.get('sport') as string;
    const originalCall = formData.get('originalCall') as string | null;
    const videoFile = formData.get('video') as File;
    const skeletonRaw = formData.get('skeletonVideo');
    const skeletonVideo = skeletonRaw instanceof File ? skeletonRaw : null;

    if (!sport || !(videoFile instanceof File)) {
      return errorJson('Missing required fields', 'BAD_FORMAT', 400);
    }

    const baseType = (videoFile.type || 'video/mp4').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_VIDEO_TYPES.includes(baseType)) {
      return errorJson('Unsupported video format. Use MP4, MOV or WebM.', 'BAD_FORMAT', 415);
    }
    if (
      videoFile.size > MAX_UPLOAD_BYTES ||
      (skeletonVideo && skeletonVideo.size > MAX_UPLOAD_BYTES)
    ) {
      const mb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
      return errorJson(`Clip is too large for analysis (limit ${mb}MB).`, 'FILE_TOO_LARGE', 413);
    }

    const arrayBuffer = await videoFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const videoBase64 = buffer.toString('base64');
    const videoMimeType = videoFile.type || 'video/mp4';

    let cvMetadata = null;
    // The CV-annotated render, kept SEPARATE from the raw clip. Observer A must
    // read the original footage: handing both observers the annotated video
    // would give them the same evidence and collapse the fan-out into two
    // samples of one opinion.
    let annotatedVideoBase64: string | null = null;
    let skeletonBase64 = null;
    let keyFramesBase64 = null;
    
    if (skeletonVideo) {
      const skelArrayBuffer = await skeletonVideo.arrayBuffer();
      skeletonBase64 = Buffer.from(skelArrayBuffer).toString('base64');
    }

    // Call the hybrid CV service to get annotated video and telemetry
    const enableCV = process.env.NEXT_PUBLIC_ENABLE_SAM === 'true';
    
    if (enableCV) {
      try {
        const cvFormData = new FormData();
        cvFormData.append('video', videoFile);

        const cvRes = await fetch('http://127.0.0.1:8000/track', {
          method: 'POST',
          body: cvFormData,
        });

        if (cvRes.ok) {
          const cvData = await cvRes.json();
          cvMetadata = cvData.metadata;
          if (cvData.videoBase64) {
            annotatedVideoBase64 = cvData.videoBase64;
          }
          if (cvData.skeletonBase64) {
            skeletonBase64 = cvData.skeletonBase64;
          }
          if (cvData.keyFramesBase64) {
            keyFramesBase64 = cvData.keyFramesBase64;
          }
        } else {
          console.warn('CV service returned error:', cvRes.status);
        }
      } catch (e) {
        console.warn('CV service unreachable. Proceeding with raw video.', e);
      }
    } else {
      console.log('CV service is disabled via NEXT_PUBLIC_ENABLE_SAM env var. Proceeding with raw video.');
    }

    const response = await runAnalysisGraph({
      sport: sport as SportId,
      videoBase64,
      videoMimeType,
      annotatedVideoBase64,
      skeletonBase64,
      originalCall: originalCall || null,
      cvMetadata,
      keyFramesBase64,
    });

    if (annotatedVideoBase64) {
      response.annotatedVideoBase64 = annotatedVideoBase64;
    }

    return NextResponse.json(response);

  } catch (error: any) {
    console.error('Analysis API Error:', error);
    
    // Check if it's a known error based on error text
    let code = 'MODEL_ERROR';
    if (error.message?.includes('FILE_TOO_LARGE')) code = 'FILE_TOO_LARGE';
    if (error.message?.includes('not found')) code = 'UNSUPPORTED_SPORT';
    
    return NextResponse.json(
      { error: error.message || 'Internal Server Error', code },
      { status: 500 }
    );
  }
}

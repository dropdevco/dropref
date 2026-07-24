import { NextResponse } from 'next/server';
import { runAnalysisPipeline } from '../../../backend/ai/pipeline';
import { SportId } from '../../../types/contract';

export const maxDuration = 60;
export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const sport = formData.get('sport') as string;
    const originalCall = formData.get('originalCall') as string | null;
    const videoFile = formData.get('video') as File;

    if (!sport || !videoFile) {
      return NextResponse.json(
        { error: 'Missing required fields', code: 'BAD_FORMAT' },
        { status: 400 }
      );
    }

    const arrayBuffer = await videoFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const videoBase64 = buffer.toString('base64');
    const videoMimeType = videoFile.type || 'video/mp4';

    let cvMetadata = null;
    let finalVideoBase64 = videoBase64;
    let skeletonBase64 = null;

    // Temporarily disabled YOLO CV service as requested
    /*
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
          finalVideoBase64 = cvData.videoBase64;
        }
        if (cvData.skeletonBase64) {
          skeletonBase64 = cvData.skeletonBase64;
        }
      } else {
        console.warn('CV service returned error:', cvRes.status);
      }
    } catch (e) {
      console.warn('CV service unreachable. Proceeding with raw video.', e);
    }
    */

    const response = await runAnalysisPipeline(
      sport as SportId,
      finalVideoBase64,
      videoMimeType,
      skeletonBase64,
      originalCall || null,
      cvMetadata
    );

    if (finalVideoBase64 !== videoBase64) {
      response.annotatedVideoBase64 = finalVideoBase64;
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

export interface VideoCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoMeta {
  width: number;
  height: number;
  duration: number;
}

/**
 * The untouched, full-frame crop. A freshly added clip must start here so the
 * editor shows the video exactly as uploaded — no crop is "pre-applied".
 */
export const DEFAULT_VIDEO_CROP: VideoCrop = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

/**
 * True when the crop is still the untouched full frame, i.e. the user has not
 * changed zoom or crop. Callers use this to skip re-encoding and analyze the
 * original file directly.
 */
export function isDefaultCrop(crop: VideoCrop): boolean {
  const EPS = 1e-4;
  return (
    Math.abs(crop.x - DEFAULT_VIDEO_CROP.x) < EPS &&
    Math.abs(crop.y - DEFAULT_VIDEO_CROP.y) < EPS &&
    Math.abs(crop.width - DEFAULT_VIDEO_CROP.width) < EPS &&
    Math.abs(crop.height - DEFAULT_VIDEO_CROP.height) < EPS
  );
}

const OUTPUT_LONG_EDGE = 960;
const FRAME_RATE = 30;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function normalizedCrop(crop: VideoCrop): VideoCrop {
  const width = clamp(crop.width, 0.12, 1);
  const height = clamp(crop.height, 0.12, 1);

  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

export function sourceCropRect(
  meta: Pick<VideoMeta, 'width' | 'height'>,
  crop: VideoCrop,
) {
  const safe = normalizedCrop(crop);

  return {
    x: safe.x * meta.width,
    y: safe.y * meta.height,
    width: safe.width * meta.width,
    height: safe.height * meta.height,
  };
}

export function outputSize(
  meta: Pick<VideoMeta, 'width' | 'height'>,
  crop: VideoCrop,
): { width: number; height: number } {
  const rect = sourceCropRect(meta, crop);
  const aspect = rect.width / rect.height;

  if (aspect >= 1) {
    return {
      width: OUTPUT_LONG_EDGE,
      height: Math.round(OUTPUT_LONG_EDGE / aspect),
    };
  }

  return {
    width: Math.round(OUTPUT_LONG_EDGE * aspect),
    height: OUTPUT_LONG_EDGE,
  };
}

export function drawCroppedVideoFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  crop: VideoCrop,
) {
  const meta = {
    width: video.videoWidth,
    height: video.videoHeight,
  };
  if (!meta.width || !meta.height) return;

  const size = outputSize(meta, crop);
  if (canvas.width !== size.width || canvas.height !== size.height) {
    canvas.width = size.width;
    canvas.height = size.height;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rect = sourceCropRect(meta, crop);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    video,
    rect.x,
    rect.y,
    rect.width,
    rect.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
}

function recordingMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

/**
 * Re-encode `file` to just the cropped region.
 *
 * The clip is played back in real time to capture it, so `onProgress` reports
 * genuine completion (0 → 1) rather than an indeterminate spinner — the UI uses
 * it to show an honest progress bar.
 */
export async function cropVideoFile(
  file: File,
  crop: VideoCrop,
  onProgress?: (ratio: number) => void,
): Promise<File> {
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video cropping is not supported in this browser.');
  }

  const sourceUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  let stream: MediaStream | null = null;

  try {
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Could not load video metadata.'));
      video.src = sourceUrl;
    });

    const safeCrop = normalizedCrop(crop);
    drawCroppedVideoFrame(video, canvas, safeCrop);

    stream = canvas.captureStream(FRAME_RATE);
    const mimeType = recordingMimeType();
    const recorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined,
    );
    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error('Could not record crop.'));
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
      };
    });

    let raf = 0;
    const draw = () => {
      drawCroppedVideoFrame(video, canvas, safeCrop);
      if (onProgress && Number.isFinite(video.duration) && video.duration > 0) {
        onProgress(Math.min(video.currentTime / video.duration, 1));
      }
      if (!video.ended) {
        raf = requestAnimationFrame(draw);
      }
    };

    if (video.currentTime !== 0) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('Could not seek video.'));
        video.currentTime = 0;
      });
    }

    recorder.start(250);
    draw();
    await video.play();

    await new Promise<void>((resolve) => {
      video.onended = () => resolve();
    });

    cancelAnimationFrame(raf);
    drawCroppedVideoFrame(video, canvas, safeCrop);
    onProgress?.(1);
    if (recorder.state !== 'inactive') recorder.stop();

    const blob = await stopped;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'clip';
    return new File([blob], `${baseName}-cropped.webm`, {
      type: blob.type || 'video/webm',
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
    stream?.getTracks().forEach((track) => track.stop());
    video.removeAttribute('src');
    video.load();
  }
}

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

/** An in/out point pair, in seconds, selecting part of the source timeline. */
export interface VideoTrim {
  start: number;
  end: number;
}

/** True when the trim still covers the whole clip (nothing to cut). */
export function isFullTrim(trim: VideoTrim | null, duration: number): boolean {
  if (!trim) return true;
  const EPS = 0.05;
  return (
    trim.start <= EPS &&
    (!Number.isFinite(duration) || trim.end >= duration - EPS)
  );
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
  options: {
    /** In/out points in seconds. Omit (or null) to encode the whole clip. */
    trim?: VideoTrim | null;
    onProgress?: (ratio: number) => void;
  } = {},
): Promise<File> {
  const { trim = null, onProgress } = options;
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

    // Resolve the segment to capture. Without a trim this is the whole clip,
    // so behaviour is unchanged for untrimmed videos.
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const startAt = trim ? Math.max(0, Math.min(trim.start, duration)) : 0;
    const endAt =
      trim && trim.end > startAt ? Math.min(trim.end, duration || trim.end) : duration;
    const span = Math.max(endAt - startAt, 0.01);

    // Seek to the in-point BEFORE recording starts, so the first captured
    // frame is the start of the selection.
    if (Math.abs(video.currentTime - startAt) > 0.01) {
      await new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error('Could not seek video.'));
        video.currentTime = startAt;
      });
    }

    let raf = 0;
    let settled = false;
    let resolveFinished: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    const done = () => {
      if (settled) return;
      settled = true;
      video.pause();
      resolveFinished();
    };
    video.onended = done;

    // The out-point is enforced here: capture stops mid-clip once the playhead
    // passes `endAt`, so only the selected segment is recorded. `hasOutPoint`
    // guards the case where duration is unknown (0) — then we rely on `ended`.
    const hasOutPoint = endAt > startAt + 0.01;
    const tick = () => {
      drawCroppedVideoFrame(video, canvas, safeCrop);
      onProgress?.(Math.min(Math.max((video.currentTime - startAt) / span, 0), 1));
      if (hasOutPoint && video.currentTime >= endAt - 0.02) {
        done();
        return;
      }
      if (video.ended) {
        done();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    recorder.start(250);
    raf = requestAnimationFrame(tick);
    await video.play();
    await finished;

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

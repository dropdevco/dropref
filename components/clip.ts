/**
 * OWNER: Dev A (frontend).
 * Client-side clip validation.
 *
 * Users upload a whole recording and trim it down to the moment, so the SOURCE
 * limits are generous while the analysed SELECTION stays short. Only the trimmed
 * selection is ever encoded and uploaded (downscaled to 960px/30fps by
 * `lib/video-crop.ts`), so a large source never reaches the server or the model
 * — it only costs browser memory and scrubbing responsiveness.
 */

/** Source file cap — comfortably fits a couple of minutes of 1080p phone video. */
export const MAX_SOURCE_BYTES = 150 * 1024 * 1024; // 150MB
/** Source duration cap — long enough to upload a full passage of play. */
export const MAX_SOURCE_DURATION_S = 300; // 5 minutes
/**
 * Longest selection that can be sent for analysis. The encoder records in real
 * time, so this also bounds how long "Set this video" takes.
 */
export const MAX_SELECTION_S = 18;
/** Shortest selection worth analysing. */
export const MIN_SELECTION_S = 1;
export const DURATION_METADATA_TOLERANCE_S = 0.25;

/** Accepted container/MIME types: mp4, mov, webm. */
export const ACCEPTED_MIME = ['video/mp4', 'video/quicktime', 'video/webm'];
export const ACCEPT_ATTR = '.mp4,.mov,.webm,video/mp4,video/quicktime,video/webm';

export type ClipCheck = { ok: true } | { ok: false; reason: string };

function hasAllowedExtension(name: string): boolean {
  return /\.(mp4|mov|webm)$/i.test(name);
}

/** Synchronous checks: type + size. Duration is validated separately (async). */
export function checkFileMeta(file: File): ClipCheck {
  const typeOk =
    ACCEPTED_MIME.includes(file.type) || hasAllowedExtension(file.name);
  if (!typeOk) {
    return { ok: false, reason: 'Unsupported format. Use MP4, MOV, or WebM.' };
  }
  if (file.size > MAX_SOURCE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(0);
    const maxMb = MAX_SOURCE_BYTES / (1024 * 1024);
    return { ok: false, reason: `Video is ${mb}MB. Max is ${maxMb}MB.` };
  }
  return { ok: true };
}

/** Human-readable m:ss for timeline labels. */
export function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}`;
}

/**
 * Read a video's duration client-side from a detached <video> element,
 * BEFORE any upload. Resolves to seconds; rejects if the browser can't
 * read the metadata.
 */
export function readVideoDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      resolve(el.duration);
      el.removeAttribute('src');
    };
    el.onerror = () => reject(new Error('Could not read video metadata.'));
    el.src = url;
  });
}

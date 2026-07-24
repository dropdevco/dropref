/**
 * OWNER: Dev A (frontend).
 * Client-side clip validation — kept in lockstep with the server route
 * (20MB cap) plus a UI-only 18-second duration cap.
 */

export const MAX_BYTES = 20 * 1024 * 1024; // 20MB — matches the API route
export const MAX_DURATION_S = 18; // UI-only guard
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
  if (file.size > MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { ok: false, reason: `Clip is ${mb}MB. Max is 20MB.` };
  }
  return { ok: true };
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

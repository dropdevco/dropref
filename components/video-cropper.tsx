'use client';

import {
  Crop,
  Hand,
  Pause,
  Play,
  RotateCcw,
  Scan,
  StepBack,
  StepForward,
  ZoomIn,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import { MAX_SELECTION_S } from '@/components/clip';
import { VideoTrimmer } from '@/components/video-trimmer';
import { cn } from '@/lib/utils';
import {
  DEFAULT_VIDEO_CROP,
  type VideoCrop,
  type VideoMeta,
  type VideoTrim,
} from '@/lib/video-crop';

type EditMode = 'none' | 'crop' | 'zoom';
type DragMode =
  | 'move'
  | 'n'
  | 's'
  | 'e'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw';

const MIN_CROP = 0.12;

/** The encoder normalises to 30fps, so one "frame" of transport is 1/30s. */
const FRAME_S = 1 / 30;
/** Playback-rate chips, slowest first. J/L step through this same list. */
const RATES = [0.25, 0.5, 1] as const;
/**
 * Jog gain. A full-stage-width drag traverses the trimmed selection once, so
 * the gesture always feels "sized" to the play the user is hunting for rather
 * than to the whole upload. Holding Shift shrinks that to a quarter for
 * frame-hunting; the gain is applied to each incremental move (not to the total
 * offset from pointer-down) so pressing or releasing Shift mid-drag adjusts
 * sensitivity from here on instead of teleporting the playhead.
 */
const FINE_JOG_GAIN = 0.25;
/**
 * Pinch gain: spreading your fingers by the full stage width moves ~1.5x the
 * selection. Pinches are short travel compared to a drag, so they need more
 * seconds-per-pixel to feel like they reach anywhere.
 */
const PINCH_SCRUB_GAIN = 1.5;
/**
 * How long a wheel/trimmer scrub keeps the trim-window loop guard suspended
 * once the input goes quiet. Long enough to bridge the gaps between trackpad
 * momentum ticks, short enough that the loop snaps back promptly after.
 */
const GUARD_RESUME_MS = 400;

const HANDLES: { mode: DragMode; className: string; cursor: string }[] = [
  {
    mode: 'nw',
    className: '-left-3 -top-3',
    cursor: 'cursor-nwse-resize',
  },
  {
    mode: 'n',
    className: 'left-1/2 -top-3 -translate-x-1/2',
    cursor: 'cursor-ns-resize',
  },
  {
    mode: 'ne',
    className: '-right-3 -top-3',
    cursor: 'cursor-nesw-resize',
  },
  {
    mode: 'e',
    className: '-right-3 top-1/2 -translate-y-1/2',
    cursor: 'cursor-ew-resize',
  },
  {
    mode: 'se',
    className: '-bottom-3 -right-3',
    cursor: 'cursor-nwse-resize',
  },
  {
    mode: 's',
    className: '-bottom-3 left-1/2 -translate-x-1/2',
    cursor: 'cursor-ns-resize',
  },
  {
    mode: 'sw',
    className: '-bottom-3 -left-3',
    cursor: 'cursor-nesw-resize',
  },
  {
    mode: 'w',
    className: '-left-3 top-1/2 -translate-y-1/2',
    cursor: 'cursor-ew-resize',
  },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = Math.floor(safe % 60)
    .toString()
    .padStart(2, '0');
  return `${mins}:${secs}`;
}

/** Scrub HUD needs sub-second resolution the m:ss readout deliberately hides. */
function formatTimecode(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const mins = Math.floor(safe / 60);
  const secs = (safe % 60).toFixed(2).padStart(5, '0');
  return `${mins}:${secs}`;
}

function formatDelta(seconds: number): string {
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.abs(seconds).toFixed(2)}s`;
}

function safeCrop(crop: VideoCrop): VideoCrop {
  const width = clamp(crop.width, MIN_CROP, 1);
  const height = clamp(crop.height, MIN_CROP, 1);

  return {
    x: clamp(crop.x, 0, 1 - width),
    y: clamp(crop.y, 0, 1 - height),
    width,
    height,
  };
}

function resizeCrop(
  crop: VideoCrop,
  mode: DragMode,
  dx: number,
  dy: number,
): VideoCrop {
  const start = safeCrop(crop);
  let { x, y, width, height } = start;

  if (mode === 'move') {
    return safeCrop({
      ...start,
      x: start.x + dx,
      y: start.y + dy,
    });
  }

  if (mode.includes('w')) {
    const nextX = clamp(x + dx, 0, x + width - MIN_CROP);
    width += x - nextX;
    x = nextX;
  }

  if (mode.includes('e')) {
    width = clamp(width + dx, MIN_CROP, 1 - x);
  }

  if (mode.includes('n')) {
    const nextY = clamp(y + dy, 0, y + height - MIN_CROP);
    height += y - nextY;
    y = nextY;
  }

  if (mode.includes('s')) {
    height = clamp(height + dy, MIN_CROP, 1 - y);
  }

  return safeCrop({ x, y, width, height });
}

function zoomCrop(crop: VideoCrop, scale: number): VideoCrop {
  const start = safeCrop(crop);
  const centerX = start.x + start.width / 2;
  const centerY = start.y + start.height / 2;
  // Clamp to [MIN_CROP, 1] explicitly: zooming out must never grow the crop
  // rect past the full frame (width/height of 1), and zooming in must never
  // shrink it past the minimum crop size.
  const width = clamp(start.width / scale, MIN_CROP, 1);
  const height = clamp(start.height / scale, MIN_CROP, 1);

  return safeCrop({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  });
}

function pointerDistance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function VideoCropper({
  src,
  crop,
  onCropChange,
  trim,
  onTrimChange,
}: {
  src: string;
  crop: VideoCrop;
  onCropChange: (crop: VideoCrop) => void;
  trim: VideoTrim | null;
  onTrimChange: (trim: VideoTrim) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const cropRef = useRef(crop);
  const dragRef = useRef<{
    mode: DragMode;
    startCrop: VideoCrop;
    startX: number;
    startY: number;
  } | null>(null);
  const activePointers = useRef(new Map<number, { x: number; y: number }>());
  const lastPinchDistance = useRef<number | null>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [mode, setMode] = useState<EditMode>('none');
  const [rate, setRate] = useState<number>(1);
  const modeRef = useRef(mode);

  // --- Transport / scrub state -------------------------------------------
  // Pointers currently held on the STAGE (mode 'none' only). Kept separate from
  // `activePointers`, which belongs to the crop/zoom overlay, so the two gesture
  // systems can never see each other's fingers.
  const stagePointers = useRef(new Map<number, { x: number; y: number }>());
  /** Live grab: set on stage pointer-down, cleared on the last pointer-up. */
  const grabRef = useRef<{
    lastX: number;
    /** Where the playhead was when the grab began — drives the HUD delta. */
    startTime: number;
    /** Accumulated jog target, so gain changes mid-drag don't teleport. */
    targetTime: number;
    /** Restore this on release: a grab must not silently stop the clip. */
    wasPlaying: boolean;
  } | null>(null);
  const pinchRef = useRef<{ distance: number; time: number } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [grabDelta, setGrabDelta] = useState(0);
  /**
   * While true, `onTimeUpdate` stops yanking the playhead back into the trim
   * window. Every scrub path sets it; without it the loop guard fights the user
   * for the playhead on the very first seek outside the selection.
   */
  const loopSuspended = useRef(false);
  const guardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set once the user deliberately pauses (Pause button, a grab, a frame step),
  // so the autoplay safety net in onCanPlay never fights an explicit stop.
  const userPausedRef = useRef(false);
  // Handlers below read trim/duration through refs because the native wheel
  // listener and the pointer-capture callbacks outlive the render that created
  // them.
  const trimRef = useRef(trim);
  const durationRef = useRef(0);

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    trimRef.current = trim;
  }, [trim]);

  useEffect(() => {
    durationRef.current = meta?.duration ?? 0;
  }, [meta]);

  const originalAspect = useMemo(() => {
    if (!meta?.width || !meta.height) return 16 / 9;
    return meta.width / meta.height;
  }, [meta]);

  const updateCrop = useCallback(
    (next: VideoCrop) => {
      const updated = safeCrop(next);
      cropRef.current = updated;
      onCropChange(updated);
    },
    [onCropChange],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, dragMode: DragMode) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      lastPinchDistance.current = null;
      dragRef.current = {
        mode: dragMode,
        startCrop: cropRef.current,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [],
  );

  const drag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const stage = stageRef.current;
      if (!stage) return;

      if (activePointers.current.has(event.pointerId)) {
        activePointers.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      }

      const active = dragRef.current;
      if (!active) return;

      event.preventDefault();
      const points = Array.from(activePointers.current.values());
      if (mode === 'zoom' && points.length >= 2) {
        const distance = pointerDistance(points[0], points[1]);
        const previous = lastPinchDistance.current ?? distance;
        if (previous > 0) {
          updateCrop(zoomCrop(cropRef.current, distance / previous));
        }
        lastPinchDistance.current = distance;
        return;
      }

      const rect = stage.getBoundingClientRect();
      updateCrop(
        resizeCrop(
          active.startCrop,
          active.mode,
          (event.clientX - active.startX) / Math.max(rect.width, 1),
          (event.clientY - active.startY) / Math.max(rect.height, 1),
        ),
      );
    },
    [mode, updateCrop],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    activePointers.current.delete(event.pointerId);
    if (activePointers.current.size === 0) {
      dragRef.current = null;
      lastPinchDistance.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------
  // Transport: seeking, the trim-window loop guard, and gesture scrubbing.
  // ---------------------------------------------------------------------

  /**
   * Seconds that one full stage width of gesture should traverse. Scaling to
   * the *selection* (not the whole upload) is what makes the jog usable: on a
   * 5-minute source, mapping the stage to the whole clip would make one pixel
   * worth a third of a second.
   */
  const jogSpan = useCallback(() => {
    const active = trimRef.current;
    if (active && active.end > active.start) return active.end - active.start;
    return durationRef.current || 1;
  }, []);

  /**
   * Stop `onTimeUpdate` from snapping the playhead back to trim.start.
   * `temporary` is for discrete/streaming scrubs that happen *while the clip is
   * still playing* (wheel, timeline drag): nothing will "resume" to clear the
   * flag, so it self-clears once the input goes quiet. A grab passes false —
   * the hold can last as long as the user likes, and release re-arms the guard.
   */
  const suspendLoopGuard = useCallback((temporary: boolean) => {
    loopSuspended.current = true;
    if (guardTimer.current) clearTimeout(guardTimer.current);
    guardTimer.current = null;
    if (!temporary) return;
    guardTimer.current = setTimeout(() => {
      loopSuspended.current = false;
      guardTimer.current = null;
    }, GUARD_RESUME_MS);
  }, []);

  const resumeLoopGuard = useCallback(() => {
    if (guardTimer.current) clearTimeout(guardTimer.current);
    guardTimer.current = null;
    loopSuspended.current = false;
  }, []);

  useEffect(() => () => {
    if (guardTimer.current) clearTimeout(guardTimer.current);
  }, []);

  /** Absolute seek. Paints `time` optimistically because `timeupdate` can lag
   *  a seek by a frame, which reads as lag on the HUD and the playhead. */
  const seekTo = useCallback((seconds: number) => {
    const video = videoRef.current;
    if (!video) return 0;
    const duration = durationRef.current || (Number.isFinite(video.duration) ? video.duration : 0);
    const next = clamp(seconds, 0, duration > 0 ? duration : seconds);
    video.currentTime = next;
    setTime(next);
    return next;
  }, []);

  /**
   * Relative seek from wherever the playhead actually is right now. Stepping
   * implies pausing, as in every NLE: a single frame stepped forward while the
   * clip is running is gone again before the user's eye lands on it.
   */
  const nudgeTime = useCallback(
    (delta: number) => {
      const video = videoRef.current;
      if (!video) return;
      if (!video.paused) {
        video.pause();
        // The autoplay safety net must treat this as a deliberate pause.
        userPausedRef.current = true;
        setPlaying(false);
      }
      // Suspended without a timer: we are now parked, and the loop guard should
      // stay out of the way until the user presses play again.
      suspendLoopGuard(false);
      seekTo(video.currentTime + delta);
    },
    [seekTo, suspendLoopGuard],
  );

  const changeRate = useCallback((next: number) => {
    setRate(next);
    const video = videoRef.current;
    if (video) video.playbackRate = next;
  }, []);

  /** J/L transport: step through RATES without wrapping. */
  const stepRate = useCallback(
    (direction: -1 | 1) => {
      const index = RATES.indexOf(rate as (typeof RATES)[number]);
      const from = index === -1 ? RATES.length - 1 : index;
      changeRate(RATES[clamp(from + direction, 0, RATES.length - 1)]);
    },
    [changeRate, rate],
  );

  // React attaches onWheel as a passive listener, so calling
  // event.preventDefault() from a synthetic handler is a no-op and the page
  // scrolls underneath the editor while the user tries to zoom. Attaching a
  // native, non-passive listener lets us actually block the scroll — but
  // only while the zoom tool is active, or for the one wheel gesture the
  // idle stage claims (see the arbitration rule below).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onWheel = (event: WheelEvent) => {
      if (modeRef.current === 'zoom') {
        event.preventDefault();
        updateCrop(zoomCrop(cropRef.current, 1 - event.deltaY * 0.0015));
        return;
      }
      // Crop mode owns no wheel gesture — let the page scroll.
      if (modeRef.current !== 'none') return;

      // ARBITRATION RULE for the idle stage: we only take the wheel when the
      // user's intent is unambiguous — either the gesture is more horizontal
      // than vertical (a trackpad two-finger sideways swipe, which no part of
      // this page scrolls with anyway) or Shift is held. A plain vertical wheel
      // over the stage stays with the document, because the stage is the
      // tallest thing on the page and trapping it would strand the reader
      // mid-page with no way out.
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (!horizontal && !event.shiftKey) return;

      const video = videoRef.current;
      if (!video) return;
      event.preventDefault();

      // Mouse wheels report deltaMode=LINE; normalise to something pixel-ish so
      // one notch is not a 1-line no-op next to a trackpad's pixel deltas.
      const raw = horizontal ? event.deltaX : event.deltaY;
      const px = event.deltaMode === 1 ? raw * 16 : raw;
      const width = Math.max(stage.getBoundingClientRect().width, 1);

      suspendLoopGuard(!video.paused);
      seekTo(video.currentTime + (px / width) * jogSpan());
    };

    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [jogSpan, seekTo, suspendLoopGuard, updateCrop]);

  useEffect(() => {
    setMeta(null);
    setPlaying(false);
    setTime(0);
    setRate(1);
    resumeLoopGuard();
  }, [resumeLoopGuard, src]);

  // A remount or a `src` swap gives us a fresh media element at 1x, so re-apply
  // the chosen rate rather than letting the chip lie about what's playing.
  useEffect(() => {
    const video = videoRef.current;
    if (video) video.playbackRate = rate;
  }, [rate, src]);

  const togglePlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      userPausedRef.current = false;
      // Resuming is the moment the trim window becomes authoritative again —
      // whatever the user scrubbed to, the preview goes back to looping only
      // the segment that will actually be analysed.
      resumeLoopGuard();
      await video.play().catch(() => {});
      setPlaying(true);
    } else {
      userPausedRef.current = true;
      video.pause();
      setPlaying(false);
    }
  }, [resumeLoopGuard]);

  // ---------------------------------------------------------------------
  // Stage gestures (mode 'none' only): grab / jog / pinch-to-scrub.
  //
  // Every handler bails when a tool is active. Belt and braces: the crop
  // overlay stopPropagation()s its own pointer-downs, so in practice these
  // never even fire in crop/zoom mode — but the mode check means a stray event
  // (e.g. a press on the letterboxed margin outside the crop box) can never be
  // mistaken for a scrub.
  // ---------------------------------------------------------------------

  const grabStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (modeRef.current !== 'none') return;
      const video = videoRef.current;
      if (!video) return;

      event.currentTarget.setPointerCapture(event.pointerId);
      stagePointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      if (stagePointers.current.size === 1) {
        const wasPlaying = !video.paused;
        // Grab means hold: freeze the frame on contact so the clip stops
        // sliding out from under the finger before the drag even starts.
        video.pause();
        userPausedRef.current = true;
        suspendLoopGuard(false);
        grabRef.current = {
          lastX: event.clientX,
          startTime: video.currentTime,
          targetTime: video.currentTime,
          wasPlaying,
        };
        setTime(video.currentTime);
        setGrabDelta(0);
        setGrabbing(true);
      } else {
        // Second finger down: hand over to pinch. Re-baseline on the next move
        // so the pinch starts from zero rather than from the spread the fingers
        // happened to land with.
        pinchRef.current = null;
      }
    },
    [suspendLoopGuard],
  );

  const grabMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const grab = grabRef.current;
      if (!grab || modeRef.current !== 'none') return;
      if (!stagePointers.current.has(event.pointerId)) return;
      stagePointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });

      const points = Array.from(stagePointers.current.values());
      const width = Math.max(
        stageRef.current?.getBoundingClientRect().width ?? 1,
        1,
      );
      const span = jogSpan();

      if (points.length >= 2) {
        // Pinch-to-scrub. Same two-finger gesture the zoom tool uses, but here
        // it maps to TIME: spread = forward, pinch in = back. Distance is
        // measured against the baseline captured on the first two-finger move,
        // so it is absolute (no drift) for the life of the pinch.
        const distance = pointerDistance(points[0], points[1]);
        if (!pinchRef.current) {
          pinchRef.current = { distance, time: grab.targetTime };
          return;
        }
        const travel = distance - pinchRef.current.distance;
        const next = seekTo(
          pinchRef.current.time + (travel / width) * span * PINCH_SCRUB_GAIN,
        );
        grab.targetTime = next;
        grab.lastX = event.clientX;
        setGrabDelta(next - grab.startTime);
        return;
      }

      // Single-finger horizontal jog. Accumulated incrementally (see
      // FINE_JOG_GAIN) rather than derived from the pointer-down origin.
      const dx = event.clientX - grab.lastX;
      grab.lastX = event.clientX;
      const gain = event.shiftKey ? FINE_JOG_GAIN : 1;
      grab.targetTime = seekTo(grab.targetTime + (dx / width) * span * gain);
      setGrabDelta(grab.targetTime - grab.startTime);
    },
    [jogSpan, seekTo],
  );

  const grabEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!stagePointers.current.delete(event.pointerId)) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      const grab = grabRef.current;
      if (!grab) return;

      if (stagePointers.current.size > 0) {
        // Lifting one finger out of a pinch: keep holding with the other, and
        // re-anchor the jog to it so the frame doesn't jump by the gap between
        // the two contact points.
        pinchRef.current = null;
        const remaining = Array.from(stagePointers.current.values())[0];
        grab.lastX = remaining.x;
        return;
      }

      grabRef.current = null;
      pinchRef.current = null;
      setGrabbing(false);

      // Release restores what the grab interrupted — and only then does the
      // trim window regain authority over the playhead.
      if (grab.wasPlaying) {
        const video = videoRef.current;
        userPausedRef.current = false;
        resumeLoopGuard();
        void video?.play().catch(() => {});
      }
    },
    [resumeLoopGuard],
  );

  /**
   * Keyboard transport on the focused stage. Scoped to events that originate on
   * the stage itself: when a crop handle has focus its arrow keys bubble here,
   * and resizing the crop must not double as a seek.
   */
  const stageKeys = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // A pointer-down on the stage focuses it (we deliberately don't
      // preventDefault, so the stage is click-to-focus). That means transport
      // keys are reachable *during* a grab — and they fight it: togglePlayback's
      // play branch calls resumeLoopGuard(), re-arming the trim snap-back while
      // the user is still dragging, which yanks every subsequent jog back to
      // trim.start and leaves a previously-paused clip playing on release.
      // The grab owns the playhead until it is released.
      if (grabRef.current) return;

      switch (event.key) {
        case ' ':
        case 'Spacebar':
        case 'k':
        case 'K':
          event.preventDefault();
          void togglePlayback();
          return;
        case 'ArrowLeft':
          event.preventDefault();
          nudgeTime(event.shiftKey ? -1 : -FRAME_S);
          return;
        case 'ArrowRight':
          event.preventDefault();
          nudgeTime(event.shiftKey ? 1 : FRAME_S);
          return;
        case 'j':
        case 'J':
          event.preventDefault();
          stepRate(-1);
          return;
        case 'l':
        case 'L':
          event.preventDefault();
          stepRate(1);
          return;
        default:
      }
    },
    [nudgeTime, stepRate, togglePlayback],
  );

  /** Timeline scrubbing, routed through the same guard suspension as the stage. */
  const scrubToFromTimeline = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (!video) return;
      suspendLoopGuard(!video.paused);
      seekTo(seconds);
    },
    [seekTo, suspendLoopGuard],
  );

  const displayedCrop = safeCrop(crop);
  const overlayVisible = mode !== 'none' && meta !== null;
  const idle = mode === 'none';

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-black/70 p-1.5">
        <div
          ref={stageRef}
          data-tour="stage"
          role="group"
          tabIndex={0}
          aria-label="Clip preview — drag to scrub, space to play, arrow keys to step frames"
          className={cn(
            'relative mx-auto overflow-hidden rounded-lg bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            idle
              // The idle stage is gestural now, so it can no longer be
              // touch-transparent — but `touch-pan-y` (rather than
              // `touch-none`) keeps the vertical axis with the document, so a
              // thumb-flick down the page still scrolls even when it lands on
              // the video. Horizontal drags and pinches are ours.
              ? 'cursor-grab touch-pan-y active:cursor-grabbing'
              // A tool is active: swallow every touch gesture so a crop drag is
              // never stolen by the scroller.
              : 'touch-none',
          )}
          style={{ aspectRatio: `${originalAspect}` }}
          onPointerDown={grabStart}
          onPointerMove={grabMove}
          onPointerUp={grabEnd}
          onPointerCancel={grabEnd}
          onKeyDown={stageKeys}
        >
          {/* The clip itself is the preview — it plays immediately so the
              editor never shows a black frame. Sizing the stage to the
              video's true aspect ratio (once known) means object-contain
              never has to letterbox, so DOM overlay coordinates expressed
              as percentages of this box line up exactly with the video
              content. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            ref={videoRef}
            src={src}
            className="h-full w-full object-contain"
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            aria-hidden="true"
            tabIndex={-1}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              const duration = Number.isFinite(video.duration)
                ? video.duration
                : 0;
              setMeta({
                width: video.videoWidth,
                height: video.videoHeight,
                duration,
              });
              // Seed the selection: whole clip, but never longer than the
              // analysable maximum, so a long upload opens ready to trim.
              if (!trim && duration > 0) {
                onTrimChange({
                  start: 0,
                  end: Math.min(duration, MAX_SELECTION_S),
                });
              }
            }}
            onCanPlay={(event) => {
              // Belt-and-suspenders autoplay: the `autoPlay` attribute alone is
              // not always honoured (React re-mounts, iOS Low Power Mode), but a
              // muted play() is always permitted. Skip it if the user paused on
              // purpose, or if this instance isn't rendered (the idle screen
              // mounts both a mobile and a desktop layout; only one is visible,
              // and waking the hidden one would decode the clip twice).
              const el = event.currentTarget;
              if (userPausedRef.current || el.offsetParent === null) return;
              void el.play().catch(() => {});
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              // Loop within the trimmed window: the preview should play exactly
              // the segment that will be analysed.
              //
              // ...unless the user is holding/scrubbing. Seeking fires
              // timeupdate too, so without this bail every scrub outside the
              // selection would be yanked straight back to trim.start and the
              // playhead would be impossible to place. The guard is re-armed on
              // resume (see togglePlayback / grabEnd), which is deliberate: if
              // you scrubbed outside the window and press play, the preview
              // returns to previewing the actual selection.
              if (!loopSuspended.current && trim && trim.end > trim.start) {
                if (video.currentTime >= trim.end || video.currentTime < trim.start - 0.05) {
                  video.currentTime = trim.start;
                }
              }
              setTime(video.currentTime);
            }}
            onPlay={() => {
              setPlaying(true);
              resumeLoopGuard();
            }}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />

          {/* Scrub HUD. Kept mounted (not conditionally rendered) so it can
              cross-fade instead of popping — `motion-safe:` drops the fade for
              reduced-motion users, who then just get an instant swap. Only
              exists in idle mode, where it can never cover the crop box. */}
          {idle && (
            <div
              aria-hidden={!grabbing}
              className={cn(
                'pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-3 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-6 motion-safe:transition-opacity motion-safe:duration-150',
                grabbing ? 'opacity-100' : 'opacity-0',
              )}
            >
              <span className="eyebrow text-white/70">
                <Hand className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                Scrubbing
              </span>
              <span className="tabular font-display text-xs font-semibold text-white">
                {formatTimecode(time)}
                <span className="ml-2 text-primary">
                  {formatDelta(grabDelta)}
                </span>
              </span>
            </div>
          )}

          {overlayVisible && (
            <div
              className={`absolute touch-none ${
                mode === 'zoom' ? 'cursor-grab active:cursor-grabbing' : 'cursor-move'
              }`}
              style={{
                left: `${displayedCrop.x * 100}%`,
                top: `${displayedCrop.y * 100}%`,
                width: `${displayedCrop.width * 100}%`,
                height: `${displayedCrop.height * 100}%`,
              }}
              onPointerDown={(event) => startDrag(event, 'move')}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <span className="pointer-events-none absolute inset-0 ring-2 ring-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" />
              <span className="pointer-events-none absolute left-1/3 top-0 h-full w-px bg-white/25" />
              <span className="pointer-events-none absolute left-2/3 top-0 h-full w-px bg-white/25" />
              <span className="pointer-events-none absolute left-0 top-1/3 h-px w-full bg-white/25" />
              <span className="pointer-events-none absolute left-0 top-2/3 h-px w-full bg-white/25" />

              {mode === 'crop' &&
                HANDLES.map((handle) => (
                  <button
                    key={handle.mode}
                    type="button"
                    aria-label={`Resize crop ${handle.mode}`}
                    className={`absolute h-7 w-7 rounded-full border-2 border-black bg-primary shadow-[0_0_18px_rgb(34_197_94/0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${handle.className} ${handle.cursor}`}
                    onPointerDown={(event) => startDrag(event, handle.mode)}
                    onPointerMove={drag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  />
                ))}
            </div>
          )}
        </div>
      </div>

      {/* Duration trim — only the selected span is encoded and analysed. */}
      {/* The wrapper exists solely to carry the product tour's `data-tour`
          anchor; VideoTrimmer's own root is a block element inside this
          space-y-3 column, so wrapping it is layout-neutral. */}
      {meta && meta.duration > 0 && trim && (
        <div data-tour="trim">
          <VideoTrimmer
            duration={meta.duration}
            trim={trim}
            current={time}
            onTrimChange={onTrimChange}
            onScrub={scrubToFromTimeline}
          />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2" data-tour="crop-zoom">
        <Button
          type="button"
          variant={mode === 'crop' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={mode === 'crop'}
          onClick={() => setMode((current) => (current === 'crop' ? 'none' : 'crop'))}
          className={`gap-2 ${mode === 'crop' ? 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background' : ''}`}
        >
          <Crop className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Crop
        </Button>
        <Button
          type="button"
          variant={mode === 'zoom' ? 'default' : 'outline'}
          size="sm"
          aria-pressed={mode === 'zoom'}
          onClick={() => setMode((current) => (current === 'zoom' ? 'none' : 'zoom'))}
          className={`gap-2 ${mode === 'zoom' ? 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background' : ''}`}
        >
          <ZoomIn className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Zoom
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Transport"
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Step back one frame"
            title="Step back one frame (←)"
            onClick={() => nudgeTime(-FRAME_S)}
            className="w-9 px-0 bg-white/[0.03]"
          >
            <StepBack className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={playing ? 'Pause' : 'Play'}
            onClick={togglePlayback}
            className="gap-2 bg-white/[0.03]"
          >
            {playing ? (
              <Pause className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            ) : (
              <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            )}
            {playing ? 'Pause' : 'Play'}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Step forward one frame"
            title="Step forward one frame (→)"
            onClick={() => nudgeTime(FRAME_S)}
            className="w-9 px-0 bg-white/[0.03]"
          >
            <StepForward className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        <span className="eyebrow">
          <Scan className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          <span className="tabular">
            {formatTime(time)} / {formatTime(meta?.duration ?? 0)}
          </span>
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Playback speed"
        >
          {RATES.map((option) => (
            <Button
              key={option}
              type="button"
              variant={rate === option ? 'default' : 'outline'}
              size="sm"
              aria-pressed={rate === option}
              aria-label={`Playback speed ${option}x`}
              onClick={() => changeRate(option)}
              className={cn(
                'tabular h-7 px-2.5 text-[11px]',
                rate === option ? '' : 'bg-white/[0.03]',
              )}
            >
              {option}×
            </Button>
          ))}
        </div>

        {/* Discoverability: none of the stage gestures announce themselves. */}
        <span className="eyebrow">
          <Hand className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Hold to scrub
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onCropChange(DEFAULT_VIDEO_CROP)}
        className="w-full gap-2"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        Reset crop
      </Button>
    </div>
  );
}

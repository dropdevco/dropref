'use client';

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Scissors } from 'lucide-react';

import { MAX_SELECTION_S, MIN_SELECTION_S, formatClock } from '@/components/clip';
import type { VideoTrim } from '@/lib/video-crop';
import { cn } from '@/lib/utils';

/** Trim-editing gestures — these mutate the selection. */
type Handle = 'start' | 'end' | 'range';
/**
 * Everything the track can be dragging. `playhead` is a grab on the playhead
 * itself; `seek` is a press-and-drag anywhere on the empty track. Both move
 * playback time only and never touch the selection, which is why they are kept
 * out of `Handle` and routed around `apply()`.
 */
type Drag = Handle | 'playhead' | 'seek';

/** The encoder normalises to 30fps, so one "frame" of nudging is 1/30s. */
const FRAME_S = 1 / 30;

/**
 * Duration trimmer: drag the left/right edges of the timeline to pick the exact
 * segment to analyse. Only this selection is encoded and sent to the AI.
 *
 * The track is also the transport: pressing the empty track or grabbing the
 * playhead seeks the preview via `onScrub`, without disturbing the trim.
 */
export function VideoTrimmer({
  duration,
  trim,
  current,
  onTrimChange,
  onScrub,
}: {
  duration: number;
  trim: VideoTrim;
  /** Current playhead position, in seconds. */
  current: number;
  onTrimChange: (trim: VideoTrim) => void;
  onScrub?: (seconds: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ handle: Drag; grabOffset: number } | null>(null);
  // Latest committed trim. Repeated relative moves (arrow-key nudges, key
  // repeat) must accumulate off this rather than a render-time closure, or
  // several presses in one frame all compute from the same stale value.
  const trimRef = useRef(trim);
  useEffect(() => {
    trimRef.current = trim;
  }, [trim]);
  // Same accumulation problem for the playhead: `current` only catches up once
  // the <video> reports a timeupdate, which is a frame or more behind a burst
  // of arrow-key seeks. Relative seeks build off this ref instead.
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const pct = (s: number) => (safeDuration ? (s / safeDuration) * 100 : 0);
  const selected = Math.max(trim.end - trim.start, 0);
  const tooLong = selected > MAX_SELECTION_S + 0.05;

  const posFromEvent = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || !safeDuration) return 0;
      const ratio = (clientX - rect.left) / Math.max(rect.width, 1);
      return Math.min(Math.max(ratio, 0), 1) * safeDuration;
    },
    [safeDuration],
  );

  const apply = useCallback(
    (handle: Handle, at: number, grabOffset: number) => {
      if (!safeDuration) return;
      const base = trimRef.current;
      let next: VideoTrim;

      if (handle === 'start') {
        // Keep at least MIN, and never let the selection exceed MAX.
        const maxStart = Math.min(base.end - MIN_SELECTION_S, safeDuration);
        const minStart = Math.max(0, base.end - MAX_SELECTION_S);
        next = {
          ...base,
          start: Math.min(Math.max(at, minStart), Math.max(maxStart, 0)),
        };
      } else if (handle === 'end') {
        const minEnd = base.start + MIN_SELECTION_S;
        const maxEnd = Math.min(base.start + MAX_SELECTION_S, safeDuration);
        next = {
          ...base,
          end: Math.max(Math.min(at, maxEnd), Math.min(minEnd, safeDuration)),
        };
      } else {
        // Slide the whole window, preserving its length.
        const length = base.end - base.start;
        const start = Math.min(
          Math.max(at - grabOffset, 0),
          Math.max(safeDuration - length, 0),
        );
        next = { start, end: start + length };
      }

      // Commit locally first so back-to-back relative moves accumulate even
      // before React re-renders with the new value.
      trimRef.current = next;
      onTrimChange(next);
    },
    [onTrimChange, safeDuration],
  );

  /** Move playback time only. Never clamped to the trim window: the user is
   *  usually scrubbing precisely to *find* the play before framing it. */
  const seek = useCallback(
    (at: number) => {
      if (!onScrub || !safeDuration) return;
      const next = Math.min(Math.max(at, 0), safeDuration);
      currentRef.current = next;
      onScrub(next);
    },
    [onScrub, safeDuration],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, handle: Drag) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const at = posFromEvent(event.clientX);

      if (handle === 'seek' || handle === 'playhead') {
        // Grabbing the playhead keeps its offset under the finger so the line
        // does not snap to the touch point; pressing bare track jumps straight
        // to where the user pressed, which is what a click-to-seek should do.
        const grabOffset = handle === 'playhead' ? at - currentRef.current : 0;
        dragRef.current = { handle, grabOffset };
        if (handle === 'seek') seek(at);
        return;
      }

      dragRef.current = {
        handle,
        grabOffset: handle === 'range' ? at - trim.start : 0,
      };
    },
    [posFromEvent, seek, trim.start],
  );

  const drag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const active = dragRef.current;
      if (!active) return;
      event.preventDefault();
      const at = posFromEvent(event.clientX);
      if (active.handle === 'seek' || active.handle === 'playhead') {
        seek(at - active.grabOffset);
        return;
      }
      apply(active.handle, at, active.grabOffset);
    },
    [apply, posFromEvent, seek],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  /** Keyboard nudging, so the trimmer is operable without a pointer. */
  const nudge = (handle: 'start' | 'end', delta: number) => {
    const base = trimRef.current;
    apply(handle, (handle === 'start' ? base.start : base.end) + delta, 0);
  };

  /** Arrow-key seeking: one frame, or one second with Shift. */
  const playheadKeys = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.shiftKey ? 1 : FRAME_S;
    seek(currentRef.current + (event.key === 'ArrowLeft' ? -step : step));
  };

  const handleClasses =
    'absolute top-0 z-20 flex h-full w-5 cursor-ew-resize touch-none items-center justify-center rounded-md bg-primary shadow-[0_0_16px_hsl(var(--primary)/0.55)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="eyebrow">
          <Scissors className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Trim to the play
        </span>
        <span
          className={cn(
            'tabular font-display text-xs font-semibold',
            tooLong ? 'text-card_red' : 'text-primary',
          )}
        >
          {selected.toFixed(1)}s selected
        </span>
      </div>

      {/* timeline */}
      <div
        ref={trackRef}
        className={cn(
          // touch-pan-y (not touch-none): horizontal drags are ours to scrub
          // with, vertical swipes still scroll the page past this 56px strip.
          'relative h-14 select-none touch-pan-y rounded-lg border border-white/10 bg-black/50',
          onScrub && 'cursor-pointer',
        )}
        // Bare-track press = seek. The selected window and the three sliders all
        // stopPropagation() in startDrag, so this only ever fires for the empty
        // (dimmed) regions of the track — trim editing is never shadowed by it.
        onPointerDown={(e) => {
          if (!onScrub) return;
          startDrag(e, 'seek');
        }}
        onPointerMove={drag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* dimmed, unselected regions */}
        <div
          className="absolute inset-y-0 left-0 rounded-l-lg bg-black/70"
          style={{ width: `${pct(trim.start)}%` }}
          aria-hidden
        />
        <div
          className="absolute inset-y-0 right-0 rounded-r-lg bg-black/70"
          style={{ width: `${100 - pct(trim.end)}%` }}
          aria-hidden
        />

        {/* the selected window */}
        <div
          className={cn(
            'absolute inset-y-0 z-10 cursor-grab touch-none border-y-2 bg-primary/10 active:cursor-grabbing',
            tooLong ? 'border-card_red' : 'border-primary',
          )}
          style={{
            left: `${pct(trim.start)}%`,
            width: `${Math.max(pct(trim.end) - pct(trim.start), 0)}%`,
          }}
          onPointerDown={(e) => startDrag(e, 'range')}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />

        {/* playhead — a real slider when the parent wired up onScrub, an inert
            marker otherwise. It sits at z-20, the same layer as the in/out
            handles but EARLIER in the DOM, so when playback loops back onto
            trim.start and the two overlap, the trim handle still wins the
            press: losing the ability to retrim would hurt more than losing a
            grab on a playhead you can also reach from the bare track. */}
        {safeDuration > 0 &&
          (onScrub ? (
            <button
              type="button"
              role="slider"
              aria-label="Playhead"
              aria-valuemin={0}
              aria-valuemax={safeDuration}
              aria-valuenow={Number(current.toFixed(2))}
              aria-valuetext={formatClock(current)}
              className="absolute inset-y-0 z-20 flex w-4 -translate-x-1/2 cursor-ew-resize touch-none items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              style={{ left: `${pct(current)}%` }}
              onPointerDown={(e) => startDrag(e, 'playhead')}
              onPointerMove={drag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={playheadKeys}
            >
              <span
                className="pointer-events-none h-full w-px bg-white/80 shadow-[0_0_8px_rgba(255,255,255,0.6)]"
                aria-hidden
              />
              <span
                className="pointer-events-none absolute -top-0.5 h-1.5 w-2.5 rounded-b-sm bg-white/80"
                aria-hidden
              />
            </button>
          ) : (
            <div
              className="pointer-events-none absolute inset-y-0 z-20 w-px bg-white/80"
              style={{ left: `${pct(current)}%` }}
              aria-hidden
            />
          ))}

        {/* in / out handles */}
        <button
          type="button"
          role="slider"
          aria-label="Clip start"
          aria-valuemin={0}
          aria-valuemax={safeDuration}
          aria-valuenow={Number(trim.start.toFixed(2))}
          aria-valuetext={formatClock(trim.start)}
          className={cn(handleClasses, '-translate-x-1/2')}
          style={{ left: `${pct(trim.start)}%` }}
          onPointerDown={(e) => startDrag(e, 'start')}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge('start', -0.25); }
            if (e.key === 'ArrowRight') { e.preventDefault(); nudge('start', 0.25); }
          }}
        >
          <span className="h-5 w-0.5 rounded-full bg-black/60" aria-hidden />
        </button>
        <button
          type="button"
          role="slider"
          aria-label="Clip end"
          aria-valuemin={0}
          aria-valuemax={safeDuration}
          aria-valuenow={Number(trim.end.toFixed(2))}
          aria-valuetext={formatClock(trim.end)}
          className={cn(handleClasses, '-translate-x-1/2')}
          style={{ left: `${pct(trim.end)}%` }}
          onPointerDown={(e) => startDrag(e, 'end')}
          onPointerMove={drag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') { e.preventDefault(); nudge('end', -0.25); }
            if (e.key === 'ArrowRight') { e.preventDefault(); nudge('end', 0.25); }
          }}
        >
          <span className="h-5 w-0.5 rounded-full bg-black/60" aria-hidden />
        </button>
      </div>

      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="tabular">{formatClock(trim.start)}</span>
        <span>
          {tooLong ? (
            <span className="text-card_red">
              Max {MAX_SELECTION_S}s — shorten the selection
            </span>
          ) : (
            <>Drag the green edges · {formatClock(safeDuration)} total</>
          )}
        </span>
        <span className="tabular">{formatClock(trim.end)}</span>
      </div>
    </div>
  );
}

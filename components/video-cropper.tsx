'use client';

import { Crop, Pause, Play, RotateCcw, Scan, ZoomIn } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import { Button } from '@/components/ui/button';
import {
  DEFAULT_VIDEO_CROP,
  drawCropEditorFrame,
  type VideoCrop,
  type VideoMeta,
} from '@/lib/video-crop';

type EditMode = 'crop' | 'zoom';
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
}: {
  src: string;
  crop: VideoCrop;
  onCropChange: (crop: VideoCrop) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
  const [mode, setMode] = useState<EditMode>('crop');

  useEffect(() => {
    cropRef.current = crop;
  }, [crop]);

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
    (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      activePointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      lastPinchDistance.current = null;
      dragRef.current = {
        mode,
        startCrop: cropRef.current,
        startX: event.clientX,
        startY: event.clientY,
      };
    },
    [],
  );

  const drag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

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

      const rect = canvas.getBoundingClientRect();
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

  const handleWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (mode !== 'zoom') return;
      event.preventDefault();
      updateCrop(zoomCrop(cropRef.current, 1 - event.deltaY * 0.0015));
    },
    [mode, updateCrop],
  );

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let raf = 0;
    const draw = () => {
      drawCropEditorFrame(video, canvas, crop);
      setTime(video.currentTime);
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [crop, src]);

  useEffect(() => {
    setMeta(null);
    setPlaying(false);
    setTime(0);
  }, [src]);

  async function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      if (video.ended) video.currentTime = 0;
      await video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  }

  const displayedCrop = safeCrop(crop);

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-white/10 bg-black/70 p-1.5">
        <div
          className="relative mx-auto overflow-hidden rounded-lg bg-black"
          style={{ aspectRatio: `${originalAspect}` }}
          onWheel={handleWheel}
        >
          <canvas
            ref={canvasRef}
            className="h-full w-full"
            aria-label="Video crop editor preview"
          />

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
            <span className="pointer-events-none absolute inset-0 ring-2 ring-primary shadow-[0_0_0_9999px_rgb(0_0_0/0.02)]" />
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
        </div>

        {/* Hidden playback source. The crop rectangle above is what gets exported. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={videoRef}
          src={src}
          className="sr-only"
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            setMeta({
              width: video.videoWidth,
              height: video.videoHeight,
              duration: video.duration,
            });
            onCropChange(DEFAULT_VIDEO_CROP);
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant={mode === 'crop' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('crop')}
          className="gap-2"
        >
          <Crop className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Crop
        </Button>
        <Button
          type="button"
          variant={mode === 'zoom' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMode('zoom')}
          className="gap-2"
        >
          <ZoomIn className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Zoom
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
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

        <span className="eyebrow">
          <Scan className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          <span className="tabular">
            {formatTime(time)} / {formatTime(meta?.duration ?? 0)}
          </span>
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

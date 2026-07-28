'use client';

import {
  Crop,
  Hand,
  Play,
  RotateCcw,
  Scan,
  StepBack,
  StepForward,
  ZoomIn,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { VideoTrimmer } from '@/components/video-trimmer';
import { cn } from '@/lib/utils';

/**
 * A non-functional stand-in for the clip editor, shown ONLY while the product
 * tour is on a step that talks about it.
 *
 * Why this exists: on a genuine first visit nobody has uploaded a clip, so
 * `app/page.tsx` renders `UploadZone` and the editor is simply absent from the
 * DOM. Three tour steps — "Trim to the moment", "Work the playhead" and
 * "Reframe the play" — were therefore explaining controls the reader could not
 * see, falling back to an unanchored centred card. Mounting this in the editor's
 * slot gives those steps something real to spotlight.
 *
 * It carries the same `data-tour` anchors as the real editor
 * (`trim` / `stage` / `crop-zoom`). That is safe because the two are mutually
 * exclusive: `app/page.tsx` renders this only when there is no `previewUrl`, and
 * the real `VideoCropper` only when there is one. They can never both be mounted.
 *
 * Inert by construction: `aria-hidden` (announcing fake buttons to a screen
 * reader would be worse than silence — the tour card carries the teaching), plus
 * `pointer-events-none` so nothing here is clickable. The tour already blocks
 * pointer input page-wide and traps focus inside its card, so these are belt
 * and braces.
 */

/** Plausible-looking numbers so the trimmer renders a real-feeling selection. */
const DEMO_DURATION_S = 42;
const DEMO_TRIM = { start: 12.4, end: 26.1 };
const DEMO_CURRENT_S = 17.8;

const noop = () => {};

export function TourDemoEditor({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('pointer-events-none space-y-3 select-none', className)}
    >
      {/* -- the stage ------------------------------------------------------ */}
      <div className="overflow-hidden rounded-xl border border-white/10 bg-black/70 p-1.5">
        <div
          data-tour="stage"
          className="relative mx-auto aspect-video overflow-hidden rounded-lg bg-black"
        >
          {/* Stand-in for the clip: a floodlit-pitch suggestion rather than a
              grey box, so the frame reads as video without pretending to be a
              real play. */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(80% 120% at 50% -20%, hsl(152 45% 30% / 0.55), transparent 62%), radial-gradient(60% 90% at 85% 110%, hsl(210 70% 40% / 0.35), transparent 60%), linear-gradient(180deg, hsl(210 30% 10%), hsl(210 35% 6%))',
            }}
          />
          <div
            className="absolute inset-0 opacity-[0.18]"
            style={{
              backgroundImage:
                'linear-gradient(hsl(0 0% 100% / 0.5) 1px, transparent 1px), linear-gradient(90deg, hsl(0 0% 100% / 0.5) 1px, transparent 1px)',
              backgroundSize: '2.5rem 2.5rem',
            }}
          />

          {/* Crop box with its eight handles — this is what "Reframe the play"
              is describing, so it needs to be visible while that step is up. */}
          <div className="absolute left-[18%] top-[16%] h-[64%] w-[58%]">
            <span className="absolute inset-0 ring-2 ring-primary shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]" />
            <span className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
            <span className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
            <span className="absolute left-0 top-1/3 h-px w-full bg-white/25" />
            <span className="absolute left-0 top-2/3 h-px w-full bg-white/25" />
            {[
              '-left-2 -top-2',
              'left-1/2 -top-2 -translate-x-1/2',
              '-right-2 -top-2',
              '-right-2 top-1/2 -translate-y-1/2',
              '-bottom-2 -right-2',
              '-bottom-2 left-1/2 -translate-x-1/2',
              '-bottom-2 -left-2',
              '-left-2 top-1/2 -translate-y-1/2',
            ].map((pos) => (
              <span
                key={pos}
                className={cn(
                  'absolute h-5 w-5 rounded-full border-2 border-black bg-primary shadow-[0_0_18px_rgb(34_197_94/0.45)]',
                  pos,
                )}
              />
            ))}
          </div>

          {/* The scrub HUD, as it appears while the clip is being held. */}
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-full border border-white/10 bg-black/75 px-3 py-1 backdrop-blur">
            <span className="eyebrow text-foreground/80">
              <Hand className="h-3 w-3" strokeWidth={1.5} aria-hidden />
              <span className="tabular">0:17.8</span>
              <span className="tabular text-primary">+1.4s</span>
            </span>
          </div>
        </div>
      </div>

      {/* -- the real trimmer, driven by demo numbers ----------------------- */}
      {/* Deliberately the actual VideoTrimmer, not a lookalike: it is a pure
          prop-driven component, so reusing it means this demo can never drift
          from the control it is teaching. No `onScrub` is passed, which is what
          makes its playhead render inert. */}
      <div data-tour="trim">
        <VideoTrimmer
          duration={DEMO_DURATION_S}
          trim={DEMO_TRIM}
          current={DEMO_CURRENT_S}
          onTrimChange={noop}
        />
      </div>

      {/* -- crop / zoom ---------------------------------------------------- */}
      <div className="grid grid-cols-2 gap-2" data-tour="crop-zoom">
        <Button type="button" variant="outline" size="sm" tabIndex={-1} className="gap-2">
          <Crop className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Crop
        </Button>
        <Button type="button" variant="outline" size="sm" tabIndex={-1} className="gap-2">
          <ZoomIn className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Zoom
        </Button>
      </div>

      {/* -- transport ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="w-9 bg-white/[0.03] px-0"
          >
            <StepBack className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="gap-2 bg-white/[0.03]"
          >
            <Play className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Play
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            tabIndex={-1}
            className="w-9 bg-white/[0.03] px-0"
          >
            <StepForward className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        <span className="eyebrow">
          <Scan className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          <span className="tabular">0:17 / 0:42</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {[0.25, 0.5, 1].map((option) => (
            <Button
              key={option}
              type="button"
              variant={option === 1 ? 'default' : 'outline'}
              size="sm"
              tabIndex={-1}
              className={cn(
                'tabular h-7 px-2.5 text-[11px]',
                option === 1 ? '' : 'bg-white/[0.03]',
              )}
            >
              {option}×
            </Button>
          ))}
        </div>

        <span className="eyebrow">
          <Hand className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Hold to scrub
        </span>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        tabIndex={-1}
        className="w-full gap-2"
      >
        <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        Reset crop
      </Button>
    </div>
  );
}

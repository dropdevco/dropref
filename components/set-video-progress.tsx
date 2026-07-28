'use client';

import { Clapperboard, Film, Scissors } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Determinate progress for the "set this video" re-encode. The ratio comes from
 * real playback position inside `cropVideoFile`, so the bar reflects actual work
 * rather than an indeterminate spinner.
 */
export function SetVideoProgress({
  ratio,
  className,
}: {
  ratio: number;
  className?: string;
}) {
  const pct = Math.round(Math.min(Math.max(ratio, 0), 1) * 100);

  // Three honest stages mapped onto real progress.
  const stages = [
    { icon: Film, label: 'Reading clip' },
    { icon: Scissors, label: 'Applying your edit' },
    { icon: Clapperboard, label: 'Packing the video' },
  ];
  const active = pct < 8 ? 0 : pct < 92 ? 1 : 2;
  const ActiveIcon = stages[active].icon;

  return (
    <div
      className={cn(
        'rounded-xl border border-primary/25 bg-primary/[0.06] p-3',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="relative grid h-7 w-7 shrink-0 place-items-center">
          {/* pulsing halo so it reads as "working" even at 0% */}
          <span className="absolute inset-0 rounded-full bg-primary/25 motion-safe:animate-ping" />
          <span className="relative grid h-7 w-7 place-items-center rounded-full bg-primary/20 ring-1 ring-inset ring-primary/40">
            <ActiveIcon className="h-3.5 w-3.5 text-primary" strokeWidth={2} aria-hidden />
          </span>
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-semibold">
            {stages[active].label}
            <span className="ml-0.5 inline-block motion-safe:animate-pulse">…</span>
          </p>
          <p className="text-[11px] text-muted-foreground">
            Runs in real time — about as long as the clip.
          </p>
        </div>

        <span className="tabular shrink-0 font-display text-sm font-bold text-primary">
          {pct}%
        </span>
      </div>

      {/* the bar */}
      <div
        className="h-2 overflow-hidden rounded-full bg-white/[0.07] ring-1 ring-inset ring-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Setting video"
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/60 to-primary shadow-[0_0_14px_hsl(var(--primary)/0.6)] transition-[width] duration-200 ease-smooth"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';

import { Whistle } from '@/components/whistle';

const STAGES: { until: number; label: string }[] = [
  { until: 3, label: 'Uploading clip' },
  { until: 10, label: 'Watching the play' },
  { until: 16, label: 'Searching the rulebook' },
  { until: Infinity, label: 'Comparing against official rules' },
];

function stageIndex(elapsed: number): number {
  const i = STAGES.findIndex((s) => elapsed < s.until);
  return i === -1 ? STAGES.length - 1 : i;
}

export function AnalyzingState({ previewUrl }: { previewUrl: string | null }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Cosmetic stage timer — deliberately NOT tied to real pipeline stages.
    const started = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const idx = stageIndex(elapsed);
  const label = STAGES[idx].label;

  return (
    <div className="bezel">
      <div className="bezel-core overflow-hidden">
        {/* whistle stage */}
        <div className="relative flex flex-col items-center gap-6 px-6 pb-8 pt-12">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-primary/10 to-transparent" />

          <Whistle blowing className="w-40 sm:w-48" />

          <div className="text-center">
            <span className="eyebrow mb-2 justify-center">
              <span className="tabular text-primary">{elapsed}s</span> · under review
            </span>
            <p
              key={label}
              className="font-display text-xl font-semibold tracking-tight motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 motion-safe:duration-500"
              aria-live="polite"
            >
              {label}
              <span className="ml-0.5 inline-block animate-pulse">…</span>
            </p>
          </div>

          {/* segmented progress */}
          <div
            className="flex w-full max-w-xs gap-1.5"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={STAGES.length}
            aria-valuenow={idx + 1}
            aria-label={`${label}, step ${idx + 1} of ${STAGES.length}`}
          >
            {STAGES.map((s, i) => (
              <span
                key={s.until}
                className={`h-1.5 flex-1 overflow-hidden rounded-full transition-colors duration-500 ${
                  i <= idx ? 'bg-primary' : 'bg-white/10'
                }`}
              >
                {i === idx && (
                  <span className="anim-sheen relative block h-full w-full" />
                )}
              </span>
            ))}
          </div>
        </div>

        {previewUrl && (
          <div className="border-t border-white/5 bg-black/40 p-1.5">
            {/* Decorative muted loop of the user's own clip; progress is conveyed
                by the live-region text above, so this is hidden from AT. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={previewUrl}
              className="mx-auto max-h-56 w-full rounded-xl object-contain"
              autoPlay
              muted
              loop
              playsInline
              aria-hidden="true"
              tabIndex={-1}
            />
          </div>
        )}
      </div>
    </div>
  );
}

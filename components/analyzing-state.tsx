'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

const STAGES: { until: number; label: string }[] = [
  { until: 3, label: 'Uploading clip…' },
  { until: 10, label: 'Watching the play…' },
  { until: 16, label: 'Searching the rulebook…' },
  { until: Infinity, label: 'Comparing against official rules…' },
];

function stageFor(elapsed: number): string {
  return (STAGES.find((s) => elapsed < s.until) ?? STAGES[STAGES.length - 1])
    .label;
}

export function AnalyzingState({ previewUrl }: { previewUrl: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    // Cosmetic stage timer — deliberately NOT tied to real pipeline stages.
    const started = Date.now();
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - started) / 1000));
    }, 250);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          src={previewUrl}
          className="mx-auto max-h-72 w-full object-contain"
          autoPlay
          muted
          loop
          playsInline
        />
      </div>

      <div className="flex items-center gap-3 rounded-xl border bg-card p-4">
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" aria-live="polite">
            {stageFor(elapsed)}
          </p>
          <p className="text-xs text-muted-foreground">
            This usually takes 10–20 seconds.
          </p>
        </div>
        <span
          className="shrink-0 tabular-nums text-sm font-semibold text-muted-foreground"
          aria-label={`${elapsed} seconds elapsed`}
        >
          {elapsed}s
        </span>
      </div>
    </div>
  );
}

'use client';

import { Clapperboard } from 'lucide-react';

import type { SportId } from '@/types/contract';
import { SPORTS, type SportSample } from '@/components/sports';

export function SampleClips({
  onSelect,
  disabled,
}: {
  onSelect: (sportId: SportId, sample: SportSample) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <div className="eyebrow mb-2.5">
        <Clapperboard className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        No clip handy? Load a sample
      </div>
      <div className="flex flex-wrap gap-2">
        {SPORTS.flatMap((sport) =>
          sport.samples.map((sample) => (
            <button
              key={sample.src}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(sport.id, sample)}
              aria-label={`${sport.label} sample: ${sample.label}`}
              className="group inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] py-1.5 pl-2 pr-3 text-xs font-medium text-muted-foreground transition-[color,background-color,transform] motion-safe:active:scale-[0.96] hover:border-primary/40 hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50"
            >
              <span
                aria-hidden
                className="grid h-4 w-4 place-items-center rounded-full bg-white/5 text-[9px] transition-colors group-hover:bg-primary/20"
              >
                {sport.emoji}
              </span>
              {sample.label}
            </button>
          )),
        )}
      </div>
    </div>
  );
}

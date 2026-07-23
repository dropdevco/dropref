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
      <div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Clapperboard className="h-4 w-4 text-muted-foreground" aria-hidden />
        No clip handy? Try a sample
      </div>
      <div className="space-y-2">
        {SPORTS.map((sport) => (
          <div key={sport.id} className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground w-6 shrink-0" aria-hidden>
              {sport.emoji}
            </span>
            {sport.samples.map((sample) => (
              <button
                key={sample.src}
                type="button"
                disabled={disabled}
                onClick={() => onSelect(sport.id, sample)}
                className="rounded-full border border-input bg-background px-3 py-1 text-xs font-medium text-muted-foreground transition-[color,background-color,transform] motion-safe:active:scale-[0.96] hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                {sample.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

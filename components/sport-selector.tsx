'use client';

import type { SportId } from '@/types/contract';
import { cn } from '@/lib/utils';
import { SPORTS } from '@/components/sports';

export function SportSelector({
  value,
  onChange,
}: {
  value: SportId | null;
  onChange: (id: SportId) => void;
}) {
  return (
    <div>
      <span id="sport-selector-label" className="mb-2 block text-sm font-medium">
        Sport
      </span>
      <div
        className="grid grid-cols-3 gap-2"
        role="radiogroup"
        aria-labelledby="sport-selector-label"
      >
        {SPORTS.map((sport) => {
          const selected = value === sport.id;
          return (
            <button
              key={sport.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(sport.id)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] motion-safe:active:scale-[0.97]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                selected
                  ? 'border-primary bg-primary/5 text-foreground ring-1 ring-primary'
                  : 'border-input text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <span className="text-2xl leading-none" aria-hidden>
                {sport.emoji}
              </span>
              {sport.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

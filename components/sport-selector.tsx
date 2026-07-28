'use client';

import type { SportId } from '@/types/contract';
import { cn } from '@/lib/utils';
import { SPORTS } from '@/components/sports';

/* Minimal sporty line-glyphs (strokeWidth 1.6, currentColor). */
function SportGlyph({ id }: { id: SportId }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  if (id === 'soccer') {
    return (
      <svg {...common} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7.5l3.2 2.4-1.2 3.8h-4l-1.2-3.8L12 7.5z" />
        <path d="M12 3v4.5M4.8 9.9l3.9 2.6M19.2 9.9l-3.9 2.6M8.8 17.3l1.2-3.6M15.2 17.3l-1.2-3.6" />
      </svg>
    );
  }
  if (id === 'football') {
    return (
      <svg {...common} aria-hidden>
        <path d="M4 12c0-3.3 3.6-6 8-6s8 2.7 8 6-3.6 6-8 6-8-2.7-8-6z" />
        <path d="M4.4 9.5C6 9 8 8.8 8 8.8M19.6 14.5c-1.6.5-3.6.7-3.6.7M10 12h4M12 10.4v3.2M14.6 8.7l1 1M8.4 14.3l1 1" />
      </svg>
    );
  }
  // lacrosse — crosse (stick + head/net)
  return (
    <svg {...common} aria-hidden>
      <path d="M6 20l6-6" />
      <path d="M12 14c-2.5-2.5-2.6-6.4-.3-8.7s6.2-2.2 8.7.3c1.7 1.7 1 3.5-.5 4-1.2.4-2-.5-2-1.8 0-1.2-1-2-2-1.6-1.4.5-1.8 2.6-.5 4 .9.9.9 2.4-.4 3.4-1 .8-2.3.5-3-.6z" />
      <path d="M13.5 6.5l4 4M15.8 5.6l3.1 3.1" />
    </svg>
  );
}

export function SportSelector({
  value,
  onChange,
}: {
  value: SportId | null;
  onChange: (id: SportId) => void;
}) {
  const index = SPORTS.findIndex((s) => s.id === value);
  const count = SPORTS.length;

  return (
    <div data-tour="sport">
      <span id="sport-selector-label" className="eyebrow mb-2.5 block">
        Choose the sport
      </span>
      <div
        role="radiogroup"
        aria-labelledby="sport-selector-label"
        className="relative grid rounded-2xl border border-border bg-secondary/40 p-1.5"
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
      >
        {/* sliding thumb */}
        {index >= 0 && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-1.5 left-1.5 rounded-xl bg-gradient-to-b from-primary/25 to-primary/10 ring-1 ring-inset ring-primary/60 shadow-[0_0_20px_hsl(var(--primary)/0.25)] transition-transform duration-300 ease-smooth"
            style={{
              width: `calc((100% - 0.75rem) / ${count})`,
              transform: `translateX(calc(${index} * 100%))`,
            }}
          />
        )}

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
                'relative z-10 flex flex-col items-center gap-1.5 rounded-xl px-2 py-3 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                selected
                  ? 'text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <SportGlyph id={sport.id} />
              <span className="font-display tracking-tight">{sport.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

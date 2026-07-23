import type { Confidence } from '@/types/contract';
import { cn } from '@/lib/utils';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
};

const CONFIDENCE_META: Record<
  Confidence,
  { label: string; level: number; fill: string; knob: string; text: string }
> = {
  HIGH: {
    label: CONFIDENCE_LABEL.HIGH,
    level: 3,
    fill: 'from-card_green/40 to-card_green',
    knob: 'bg-card_green shadow-[0_0_16px_hsl(var(--card-green)/0.8)]',
    text: 'text-card_green',
  },
  MEDIUM: {
    label: CONFIDENCE_LABEL.MEDIUM,
    level: 2,
    fill: 'from-card_yellow/40 to-card_yellow',
    knob: 'bg-card_yellow shadow-[0_0_16px_hsl(var(--card-yellow)/0.8)]',
    text: 'text-card_yellow',
  },
  LOW: {
    label: CONFIDENCE_LABEL.LOW,
    level: 1,
    fill: 'from-card_red/40 to-card_red',
    knob: 'bg-card_red shadow-[0_0_16px_hsl(var(--card-red)/0.8)]',
    text: 'text-card_red',
  },
};

const TICKS = ['Low', 'Medium', 'High'];

export function ConfidenceMeter({ confidence }: { confidence: Confidence }) {
  const { label, level, fill, knob, text } = CONFIDENCE_META[confidence];
  const pct = (level / 3) * 100;

  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={3}
      aria-valuenow={level}
      aria-label={label}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">Confidence</span>
        <span className={cn('font-display text-sm font-semibold', text)}>
          {label}
        </span>
      </div>

      {/* slider track */}
      <div className="relative h-2.5 rounded-full bg-white/[0.06] ring-1 ring-inset ring-white/10">
        <div
          className={cn(
            'absolute inset-y-0 left-0 rounded-full bg-gradient-to-r transition-[width] duration-700 ease-smooth',
            fill,
          )}
          style={{ width: `${pct}%` }}
        />
        {/* knob */}
        <span
          className={cn(
            'absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background transition-[left] duration-700 ease-smooth',
            knob,
          )}
          style={{ left: `${pct}%` }}
        />
      </div>

      <div className="mt-1.5 flex justify-between px-0.5">
        {TICKS.map((t, i) => (
          <span
            key={t}
            className={cn(
              'text-[10px] font-medium',
              i + 1 === level ? text : 'text-muted-foreground/60',
            )}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

import type { Confidence } from '@/types/contract';
import { cn } from '@/lib/utils';

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
};

const CONFIDENCE_META: Record<
  Confidence,
  { label: string; segments: number; bar: string }
> = {
  HIGH: { label: CONFIDENCE_LABEL.HIGH, segments: 3, bar: 'bg-emerald-500' },
  MEDIUM: { label: CONFIDENCE_LABEL.MEDIUM, segments: 2, bar: 'bg-amber-500' },
  LOW: { label: CONFIDENCE_LABEL.LOW, segments: 1, bar: 'bg-red-500' },
};

export function ConfidenceMeter({ confidence }: { confidence: Confidence }) {
  const { label, segments, bar } = CONFIDENCE_META[confidence];
  const total = 3;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Confidence
        </span>
        <span className="text-xs font-semibold">{label}</span>
      </div>
      <div
        className="flex gap-1.5"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={segments}
        aria-label={label}
      >
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'h-2 flex-1 rounded-full transition-colors',
              i < segments ? bar : 'bg-muted',
            )}
          />
        ))}
      </div>
    </div>
  );
}

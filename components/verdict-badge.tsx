import { CircleCheck, CircleHelp, CircleX, type LucideIcon } from 'lucide-react';

import type { Verdict } from '@/types/contract';
import { cn } from '@/lib/utils';

export const VERDICT_LABEL: Record<Verdict, string> = {
  FAIR_CALL: 'Fair Call',
  BAD_CALL: 'Bad Call',
  INCONCLUSIVE: 'Inconclusive',
};

const VERDICT_META: Record<
  Verdict,
  { label: string; Icon: LucideIcon; wrap: string; icon: string }
> = {
  FAIR_CALL: {
    label: VERDICT_LABEL.FAIR_CALL,
    Icon: CircleCheck,
    wrap: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-emerald-500/30',
    icon: 'text-emerald-500',
  },
  BAD_CALL: {
    label: VERDICT_LABEL.BAD_CALL,
    Icon: CircleX,
    wrap: 'bg-red-500/10 text-red-600 dark:text-red-400 ring-red-500/30',
    icon: 'text-red-500',
  },
  INCONCLUSIVE: {
    label: VERDICT_LABEL.INCONCLUSIVE,
    Icon: CircleHelp,
    wrap: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-amber-500/30',
    icon: 'text-amber-500',
  },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { label, Icon, wrap, icon } = VERDICT_META[verdict];
  return (
    <div
      className={cn(
        'inline-flex items-center gap-2.5 rounded-full px-4 py-2 text-base font-semibold ring-1 ring-inset',
        wrap,
      )}
    >
      <Icon className={cn('h-5 w-5 shrink-0', icon)} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

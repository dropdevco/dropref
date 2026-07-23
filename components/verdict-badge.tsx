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
  {
    label: string;
    tag: string;
    Icon: LucideIcon;
    card: string;
    glow: string;
    text: string;
  }
> = {
  FAIR_CALL: {
    label: VERDICT_LABEL.FAIR_CALL,
    tag: 'GOOD CALL',
    Icon: CircleCheck,
    card: 'from-[hsl(152_62%_48%)] to-[hsl(152_66%_34%)]',
    glow: 'shadow-[0_18px_50px_-12px_hsl(152_62%_46%/0.7)]',
    text: 'text-glow-green text-card_green',
  },
  BAD_CALL: {
    label: VERDICT_LABEL.BAD_CALL,
    tag: 'WRONG CALL',
    Icon: CircleX,
    card: 'from-[hsl(0_80%_58%)] to-[hsl(0_74%_42%)]',
    glow: 'shadow-[0_18px_50px_-12px_hsl(0_78%_54%/0.7)]',
    text: 'text-glow-red text-card_red',
  },
  INCONCLUSIVE: {
    label: VERDICT_LABEL.INCONCLUSIVE,
    tag: 'TOO CLOSE',
    Icon: CircleHelp,
    card: 'from-[hsl(45_96%_58%)] to-[hsl(40_95%_46%)]',
    glow: 'shadow-[0_18px_50px_-12px_hsl(45_96%_54%/0.6)]',
    text: 'text-glow-yellow text-card_yellow',
  },
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const { label, tag, Icon, card, glow, text } = VERDICT_META[verdict];

  return (
    <div className="flex flex-col items-center gap-4">
      {/* the referee card */}
      <div
        className={cn(
          'anim-sheen relative flex aspect-[5/7] w-28 -rotate-3 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-br p-3 ring-1 ring-inset ring-white/25 transition-transform duration-500 hover:rotate-0 motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:duration-500',
          card,
          glow,
        )}
        aria-hidden
      >
        <span className="absolute inset-x-0 top-0 h-1/2 bg-white/10" />
        <Icon className="relative h-9 w-9 text-black/85" strokeWidth={2} />
        <span className="relative text-center font-display text-[11px] font-bold uppercase leading-tight tracking-wider text-black/80">
          {tag}
        </span>
      </div>

      {/* the plain-language verdict */}
      <h2
        className={cn(
          'font-display text-3xl font-bold tracking-tight sm:text-4xl',
          text,
        )}
      >
        {label}
      </h2>
    </div>
  );
}

import Image from 'next/image';

import { cn } from '@/lib/utils';

/**
 * The referee mark — the same line-art figure used for the favicon, recoloured
 * to the app's light-on-dark palette (see `public/referee.png`). Decorative by
 * default; pass a `label` when it needs an accessible name.
 */
export function RefereeMark({
  className,
  label,
  glow = false,
}: {
  className?: string;
  label?: string;
  glow?: boolean;
}) {
  return (
    <span className={cn('relative inline-grid place-items-center', className)}>
      {glow && (
        <span
          aria-hidden
          className="absolute inset-0 rounded-full bg-primary/20 blur-2xl"
        />
      )}
      <Image
        src="/referee.png"
        alt={label ?? ''}
        aria-hidden={label ? undefined : true}
        width={512}
        height={512}
        // Rendered between 24px and ~208px; without this Next ships a 1080px
        // candidate for the 24px header mark.
        sizes="256px"
        priority={false}
        className="relative h-full w-full object-contain drop-shadow-[0_10px_24px_rgba(0,0,0,0.55)]"
      />
    </span>
  );
}

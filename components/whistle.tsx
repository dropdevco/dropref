import { cn } from '@/lib/utils';

/**
 * Faux-3D referee whistle rendered as layered SVG (metallic gradients +
 * specular highlight). `blowing` swaps the idle bob for a shake and emits
 * concentric sound rings — used as the analyzing-state centerpiece.
 * Pure SVG/CSS: no 3D library.
 */
export function Whistle({
  blowing = false,
  className,
}: {
  blowing?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('relative inline-grid place-items-center', className)}>
      {/* emanating sound rings (blowing only) */}
      {blowing && (
        <>
          <span className="anim-ring pointer-events-none absolute right-2 top-1/2 h-24 w-24 -translate-y-1/2 rounded-full border border-card_green/50" />
          <span
            className="anim-ring pointer-events-none absolute right-2 top-1/2 h-24 w-24 -translate-y-1/2 rounded-full border border-card_green/40"
            style={{ animationDelay: '0.6s' }}
          />
          <span
            className="anim-ring pointer-events-none absolute right-2 top-1/2 h-24 w-24 -translate-y-1/2 rounded-full border border-card_green/30"
            style={{ animationDelay: '1.2s' }}
          />
        </>
      )}

      <svg
        viewBox="0 0 200 150"
        className={cn(
          'relative w-full drop-shadow-[0_18px_30px_rgba(0,0,0,0.55)]',
          blowing ? 'anim-blow' : 'anim-bob',
        )}
        role="img"
        aria-label="Referee whistle"
      >
        <defs>
          <linearGradient id="w-chrome" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor="#f4f7fa" />
            <stop offset="0.28" stopColor="#c3ccd4" />
            <stop offset="0.55" stopColor="#8a97a3" />
            <stop offset="0.8" stopColor="#5a6773" />
            <stop offset="1" stopColor="#3c4650" />
          </linearGradient>
          <linearGradient id="w-chrome-mouth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#dfe6ec" />
            <stop offset="0.5" stopColor="#9aa6b2" />
            <stop offset="1" stopColor="#4a545e" />
          </linearGradient>
          <radialGradient id="w-spec" cx="0.35" cy="0.28" r="0.5">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="w-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="hsl(152 62% 60%)" />
            <stop offset="1" stopColor="hsl(152 62% 38%)" />
          </linearGradient>
        </defs>

        {/* lanyard loop */}
        <path
          d="M96 30 q4 -18 22 -18 q18 0 22 16"
          fill="none"
          stroke="url(#w-chrome)"
          strokeWidth="7"
          strokeLinecap="round"
        />
        <circle cx="140" cy="30" r="7" fill="url(#w-chrome)" />
        <circle cx="140" cy="30" r="3" fill="#2b333b" />

        {/* mouthpiece */}
        <rect
          x="8"
          y="70"
          width="52"
          height="26"
          rx="7"
          fill="url(#w-chrome-mouth)"
        />
        <rect x="8" y="72" width="52" height="6" rx="3" fill="url(#w-spec)" />

        {/* barrel body */}
        <path
          d="M52 58 q60 -14 104 6 q22 10 22 30 q0 22 -24 30 q-58 16 -104 2 q-16 -6 -16 -34 q0 -28 18 -34 Z"
          fill="url(#w-chrome)"
          stroke="#2b333b"
          strokeWidth="1.5"
        />

        {/* green brand rim around the body */}
        <path
          d="M52 58 q60 -14 104 6 q22 10 22 30 q0 22 -24 30 q-58 16 -104 2 q-16 -6 -16 -34 q0 -28 18 -34 Z"
          fill="none"
          stroke="url(#w-rim)"
          strokeWidth="2.5"
          strokeOpacity="0.75"
        />

        {/* top sound slot */}
        <rect x="92" y="60" width="46" height="12" rx="6" fill="#2b333b" />
        <rect x="96" y="63" width="38" height="4" rx="2" fill="#0e1319" />

        {/* specular highlight */}
        <ellipse cx="82" cy="76" rx="44" ry="16" fill="url(#w-spec)" />
        <circle cx="60" cy="72" r="5" fill="#ffffff" fillOpacity="0.85" />
      </svg>
    </div>
  );
}

'use client';

/**
 * First-visit product tour — hand-rolled, no dependency.
 *
 * WHY NOT A LIBRARY: driver.js / react-joyride / @reactour all dim the page
 * with an SVG or box-shadow cutout, not a blur, and their popovers ship their
 * own light-DOM CSS that would have to be fought back into the "VAR booth"
 * bezel language. The blur is the whole ask here, so the overlay is ~1 file of
 * geometry and the card is just `.bezel` + `<Button>`.
 *
 * HOW THE BLUR GETS A HOLE: `backdrop-filter` cannot be masked — a CSS mask
 * hides the element's own paint but the browser still blurs everything behind
 * it. So the scrim is FOUR disjoint fixed panels (above / below / left / right
 * of the target) whose union is the viewport minus the target rect. The target
 * is therefore never behind a blurring surface and stays perfectly sharp.
 *
 * WHY THE PANELS ANIMATE top/left/width/height RATHER THAN transform:
 *   - `scale()` on a backdrop-filtered box scales the blur radius with it, so a
 *     40px-tall top panel would render a squashed, streaky blur.
 *   - Oversized translate-only half-planes would overlap in the four corners,
 *     double-applying both the blur and the dim (visible banding).
 * The panels are four childless `position: fixed` boxes, so animating their
 * geometry costs paint + compositing but triggers no document reflow.
 */

import { createPortal } from 'react-dom';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, ArrowRight, Check, GraduationCap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { TOUR_STEPS } from '@/components/tour/tour-steps';
import { cn } from '@/lib/utils';

/**
 * Bump the version to re-run the tour for everyone who has already seen it.
 * The old key is simply orphaned, which is the point.
 */
const TOUR_STORAGE_KEY = 'refcheck.tour.v1';

/** Breathing room between the target rect and the edge of the blur hole. */
const SPOT_PAD = 8;
/** Gap between the spotlight and the dialogue card. */
const CARD_GAP = 14;
/** Minimum distance from the card to any viewport edge. */
const EDGE = 12;
const CARD_MAX_W = 360;
/** Below this width a floating card never fits beside anything; dock it. */
const NARROW_VIEWPORT = 640;
/**
 * How long to keep re-measuring after a step change, so the spotlight tracks a
 * smooth `scrollIntoView` instead of snapping to where the target *was*.
 */
const FOLLOW_MS = 800;

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Spot = {
  top: number;
  left: number;
  width: number;
  height: number;
  radius: number;
};

type Viewport = { vw: number; vh: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * localStorage throws outright in some privacy modes (Safari private browsing,
 * blocked third-party storage in an iframe), so every access is guarded. A
 * throw is treated as "never seen", which at worst shows the tour again.
 *
 * Never called during render — see the mount effect in ProductTour — because
 * reading it on the server-rendered pass would produce a hydration mismatch.
 */
function hasSeenTour(): boolean {
  try {
    return window.localStorage.getItem(TOUR_STORAGE_KEY) === 'seen';
  } catch {
    return false;
  }
}

function markTourSeen(): void {
  try {
    window.localStorage.setItem(TOUR_STORAGE_KEY, 'seen');
  } catch {
    /* Storage unavailable — the tour just runs again next visit. */
  }
}

/* -------------------------------------------------------------------------- */
/* Target resolution — the duplicated-layout problem                           */
/* -------------------------------------------------------------------------- */

/**
 * Find the ONE visible element carrying `data-tour="<name>"`.
 *
 * CRITICAL: `app/page.tsx` mounts the idle screen twice — a desktop grid
 * (`hidden lg:grid`) and a mobile stack (`lg:hidden`). BOTH are in the DOM at
 * every viewport width, so `VideoCropper`, `SportSelector` and the "Check the
 * call" button each exist twice. A naive `querySelector` returns whichever
 * comes first in source order, which is the desktop copy — invisible on a
 * phone, and its rect is 0x0, so the spotlight would collapse to nothing.
 *
 * Two independent signals pick the live copy:
 *   1. Non-zero `getBoundingClientRect()` area. Tailwind's `hidden` is
 *      `display: none`, and a display:none element reports an all-zero rect, so
 *      this alone eliminates the dead twin.
 *   2. `offsetParent !== null`, used as a *tie-breaker* rather than a filter.
 *      It is null for display:none subtrees, but ALSO null for
 *      `position: fixed` elements — and the replay button (step 8) is fixed, so
 *      filtering on it would make that step unanchorable.
 *
 * Re-run on every measure, so a resize across the `lg` breakpoint re-resolves
 * to the layout that just became visible.
 */
function resolveVisibleTarget(name: string): HTMLElement | null {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(`[data-tour="${name}"]`),
  );

  let best: HTMLElement | null = null;
  let bestScore = -1;

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area <= 0) continue; // the hidden twin, or a collapsed node
    const score = area + (node.offsetParent !== null ? 1e9 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }

  return best;
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The "closed" spotlight: a zero-height slot parked on the bottom edge. The
 * top panel then covers the whole viewport on its own and the other three
 * collapse to nothing, which gives an unanchored step a single, seamless blur
 * plane — no hairline where two panels butt together.
 */
function closedSpot(vp: Viewport): Spot {
  return { top: vp.vh, left: 0, width: vp.vw, height: 0, radius: 0 };
}

/** Panel rects, in order: above / below / left of / right of the spotlight. */
function panelRects(spot: Spot, vp: Viewport) {
  const top = clamp(spot.top, 0, vp.vh);
  const bottom = clamp(spot.top + spot.height, 0, vp.vh);
  const left = clamp(spot.left, 0, vp.vw);
  const right = clamp(spot.left + spot.width, 0, vp.vw);

  return [
    { key: 'n', left: 0, top: 0, width: vp.vw, height: top },
    { key: 's', left: 0, top: bottom, width: vp.vw, height: vp.vh - bottom },
    { key: 'w', left: 0, top, width: left, height: bottom - top },
    { key: 'e', left: right, top, width: vp.vw - right, height: bottom - top },
  ];
}

/**
 * Put the card below / above / right of / left of the spotlight — first side
 * with room wins — and clamp it inside the viewport whatever happens. Narrow
 * viewports dock it to a horizontal band instead of floating it, because a
 * 360px card cannot sit beside a target that is already full-width.
 */
function placeCard(
  spot: Spot | null,
  card: { w: number; h: number },
  vp: Viewport,
): { x: number; y: number } {
  const maxX = Math.max(EDGE, vp.vw - card.w - EDGE);
  const maxY = Math.max(EDGE, vp.vh - card.h - EDGE);

  if (!spot) {
    return {
      x: clamp((vp.vw - card.w) / 2, EDGE, maxX),
      y: clamp((vp.vh - card.h) / 2, EDGE, maxY),
    };
  }

  const below = spot.top + spot.height + CARD_GAP;
  const above = spot.top - CARD_GAP - card.h;
  const rightOf = spot.left + spot.width + CARD_GAP;
  const leftOf = spot.left - CARD_GAP - card.w;

  const centredX = clamp(
    spot.left + spot.width / 2 - card.w / 2,
    EDGE,
    maxX,
  );
  const centredY = clamp(
    spot.top + spot.height / 2 - card.h / 2,
    EDGE,
    maxY,
  );

  if (vp.vw < NARROW_VIEWPORT) {
    if (below + card.h + EDGE <= vp.vh) return { x: centredX, y: below };
    if (above >= EDGE) return { x: centredX, y: above };
    // Nothing fits around it — dock to the bottom of the screen.
    return { x: centredX, y: maxY };
  }

  if (below + card.h + EDGE <= vp.vh) return { x: centredX, y: below };
  if (above >= EDGE) return { x: centredX, y: above };
  if (rightOf + card.w + EDGE <= vp.vw) return { x: rightOf, y: centredY };
  if (leftOf >= EDGE) return { x: leftOf, y: centredY };
  return { x: centredX, y: maxY };
}

function isFullyVisible(rect: DOMRect, vp: Viewport): boolean {
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= vp.vh &&
    rect.right <= vp.vw
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export function ProductTour({
  /**
   * Called whenever the tour needs the page to mount `TourDemoEditor` — i.e.
   * the current step explains the clip editor. The page owns that decision
   * because only it knows whether a real clip is already loaded, in which case
   * the real editor is on screen and no stand-in is wanted.
   */
  onEditorDemoChange,
}: {
  onEditorDemoChange?: (needed: boolean) => void;
} = {}) {
  const total = TOUR_STEPS.length;

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ vw: 0, vh: 0 });
  // True while the spotlight is chasing a moving target (scroll / resize), as
  // opposed to travelling between steps. Suppresses the geometry transition so
  // the hole stays glued to the element instead of trailing it.
  const [tracking, setTracking] = useState(false);
  const [cardSize, setCardSize] = useState({ w: CARD_MAX_W, h: 240 });
  const [reduceMotion, setReduceMotion] = useState(false);

  const cardRef = useRef<HTMLDivElement>(null);
  const replayRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const step = TOUR_STEPS[index];
  const isLast = index === total - 1;

  // Tell the page whether this step needs the editor stand-in. Runs on close
  // and on unmount too, so the demo can never outlive the tour.
  const needsEditorDemo = open && Boolean(step?.needsEditorDemo);
  useEffect(() => {
    onEditorDemoChange?.(needsEditorDemo);
  }, [needsEditorDemo, onEditorDemoChange]);
  useEffect(
    () => () => {
      onEditorDemoChange?.(false);
    },
    [onEditorDemoChange],
  );

  /* -- mount gate: nothing storage-dependent may influence the first render --
     The server and the first client render both produce `null`, so there is no
     hydration mismatch; only after this effect does the tour exist at all.
     Seeding the viewport in the same batch matters: without it the overlay
     would paint one frame with a 0x0 viewport, i.e. one frame of unblurred
     page. */
  useEffect(() => {
    setViewport({ vw: window.innerWidth, vh: window.innerHeight });
    setMounted(true);
    if (!hasSeenTour()) setOpen(true);
  }, []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduceMotion(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  /* -- measurement ---------------------------------------------------------- */

  // The follow loop below calls measure() every frame, so both setters bail on
  // an unchanged value rather than allocating a new object and re-rendering.
  const measure = useCallback(() => {
    const vp = { vw: window.innerWidth, vh: window.innerHeight };
    setViewport((current) =>
      current.vw === vp.vw && current.vh === vp.vh ? current : vp,
    );

    const name = TOUR_STEPS[index]?.target;
    const element = name ? resolveVisibleTarget(name) : null;

    if (!element) {
      // Either a deliberately unanchored step, or an anchor that does not exist
      // yet — the editor steps before any clip is uploaded. Both render the same
      // centred, spotlight-free card, so the step count never has to change.
      setSpot((current) => (current === null ? current : null));
      return;
    }

    const rect = element.getBoundingClientRect();
    const left = clamp(rect.left - SPOT_PAD, 0, vp.vw);
    const top = clamp(rect.top - SPOT_PAD, 0, vp.vh);
    const right = clamp(rect.right + SPOT_PAD, 0, vp.vw);
    const bottom = clamp(rect.bottom + SPOT_PAD, 0, vp.vh);

    // Match the target's own rounding so the ring hugs it instead of boxing it.
    const ownRadius =
      parseFloat(window.getComputedStyle(element).borderTopLeftRadius) || 0;

    const next: Spot = {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
      radius: ownRadius + SPOT_PAD,
    };

    setSpot((current) =>
      current &&
      current.left === next.left &&
      current.top === next.top &&
      current.width === next.width &&
      current.height === next.height &&
      current.radius === next.radius
        ? current
        : next,
    );
  }, [index]);

  /* -- per-step: scroll into view, then track the target -------------------- */

  useEffect(() => {
    if (!open) return;

    const name = TOUR_STEPS[index]?.target;
    if (name) {
      const element = resolveVisibleTarget(name);
      const vp = { vw: window.innerWidth, vh: window.innerHeight };
      if (element && !isFullyVisible(element.getBoundingClientRect(), vp)) {
        element.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: reduceMotion ? 'auto' : 'smooth',
        });
      }
    }

    measure();

    // Demo steps mount `TourDemoEditor` via the PAGE, in response to the
    // onEditorDemoChange effect above — so their anchor lands one commit AFTER
    // this one and the measure() we just ran found nothing. The rAF follow loop
    // below would catch it, but that makes a correct spotlight depend on
    // winning a frame race. Re-measure on the next task instead, so the anchor
    // is picked up deterministically even if rAF is throttled or starved.
    const settle = setTimeout(measure, 0);

    // Follow the scroll for a beat. `scroll` events cover the common case, but
    // this also catches layout that settles a frame or two late (fonts, the
    // video element sizing itself to its true aspect ratio).
    let frame = 0;
    const started = performance.now();
    const follow = () => {
      measure();
      if (performance.now() - started < FOLLOW_MS) {
        frame = requestAnimationFrame(follow);
      }
    };
    frame = requestAnimationFrame(follow);
    return () => {
      clearTimeout(settle);
      cancelAnimationFrame(frame);
    };
  }, [open, index, measure, reduceMotion]);

  /* -- keep the spotlight glued to the target on scroll / resize ------------ */

  useEffect(() => {
    if (!open) return;

    let frame = 0;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      // Step-to-step travel is animated (that's the nice bit), but tracking a
      // moving target is not: a 460ms ease on top/left/width/height makes the
      // hole lag the element during scroll, which briefly parks the one thing
      // that must never be blurred behind a blur panel. Snap while tracking,
      // then hand the transition back once scrolling settles.
      setTracking(true);
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => setTracking(false), 120);

      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    // `capture: true` so scrolling any inner scroller counts, not just window.
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);

    const name = TOUR_STEPS[index]?.target;
    const element = name ? resolveVisibleTarget(name) : null;
    const observer =
      element && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(schedule)
        : null;
    if (element && observer) observer.observe(element);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      if (settle) clearTimeout(settle);
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      observer?.disconnect();
    };
  }, [open, index, measure]);

  /* -- card size ------------------------------------------------------------ */

  useLayoutEffect(() => {
    if (!open) return;
    const node = cardRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setCardSize((current) =>
      Math.abs(current.w - rect.width) < 0.5 &&
      Math.abs(current.h - rect.height) < 0.5
        ? current
        : { w: rect.width, h: rect.height },
    );
  }, [open, index, viewport.vw, viewport.vh]);

  /* -- open / close --------------------------------------------------------- */

  const close = useCallback(() => {
    markTourSeen();
    setOpen(false);
    const prior = restoreFocusRef.current;
    restoreFocusRef.current = null;
    // After the overlay unmounts, put focus back where it came from. On an
    // auto-started first visit there is nothing to restore to, so the replay
    // button becomes the landing spot.
    requestAnimationFrame(() => {
      const target =
        prior && document.body.contains(prior) ? prior : replayRef.current;
      target?.focus();
    });
  }, []);

  const start = useCallback(() => {
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    setIndex(0);
    // Drop any spotlight left over from the previous run so the first frame of
    // the reopened tour cannot flash a stale rect.
    setSpot(null);
    setViewport({ vw: window.innerWidth, vh: window.innerHeight });
    setOpen(true);
  }, []);

  const goNext = useCallback(() => {
    if (index >= total - 1) {
      close();
      return;
    }
    setIndex(index + 1);
  }, [close, index, total]);

  const goBack = useCallback(() => {
    setIndex((current) => Math.max(0, current - 1));
  }, []);

  /* -- keyboard: Esc, arrows, and the focus trap ---------------------------- */

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === 'ArrowRight') {
        event.preventDefault();
        goNext();
        return;
      }

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        goBack();
        return;
      }

      if (event.key !== 'Tab') return;

      const card = cardRef.current;
      if (!card) return;
      const focusable = Array.from(
        card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        card.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? card.contains(active) : false;

      // `active === card` matters: the tour opens with focus on the dialog
      // container itself (tabIndex={-1}), which is `inside` but is neither
      // `first` nor `last`. Without it, the very first Shift+Tab fell through to
      // native traversal — and since the portal is body's LAST child, backwards
      // traversal walked straight out of the aria-modal dialog onto the page's
      // replay button sitting behind the scrim.
      if (event.shiftKey && (!inside || active === first || active === card)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, close, goNext, goBack]);

  // Keep focus in the card across step changes: "Back" is disabled on step one,
  // so advancing off it would otherwise strand focus on <body>.
  useEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    if (!card) return;
    if (!card.contains(document.activeElement)) card.focus();
  }, [open, index]);

  if (!mounted) return null;

  const anchored = spot !== null;
  const activeSpot = spot ?? closedSpot(viewport);
  const panels = panelRects(activeSpot, viewport);
  const cardPos = placeCard(spot, cardSize, viewport);

  const titleId = 'tour-title';
  const bodyId = 'tour-body';

  const overlay = open
    ? createPortal(
        <div
          className="pointer-events-none fixed inset-0 z-[120]"
          data-tracking={tracking ? 'true' : 'false'}
        >
          {/*
            Interaction blocker. This makes the page inert to POINTER input for
            the duration of the tour — including inside the spotlight — so a
            stray click cannot upload a file or fire an analysis mid-walkthrough.
            Clicking the backdrop is deliberately a no-op: only Skip, Done or Esc
            end the tour, so a misplaced click never destroys the user's place.

            Scope, precisely: keyboard is handled separately by the focus trap
            below, which keeps Tab inside the card. The page behind is NOT
            `inert` and NOT `aria-hidden`, so a screen-reader virtual cursor can
            still browse it, and the page still scrolls — the latter deliberate,
            since the spotlight tracks scrolling. Marking <main> aria-hidden
            would also hide the very element each step is pointing at.
          */}
          <div className="pointer-events-auto absolute inset-0" aria-hidden />

          {panels.map((panel) => (
            <div
              key={panel.key}
              aria-hidden
              className="tour-panel pointer-events-auto"
              style={{
                left: panel.left,
                top: panel.top,
                width: Math.max(0, panel.width),
                height: Math.max(0, panel.height),
              }}
            />
          ))}

          {/* Highlight ring. Never blurs anything — it is pure box-shadow over
              the hole the panels left. */}
          <div
            aria-hidden
            className={cn(
              'tour-ring',
              anchored ? 'opacity-100' : 'opacity-0',
            )}
            style={{
              left: activeSpot.left,
              top: activeSpot.top,
              width: activeSpot.width,
              height: activeSpot.height,
              borderRadius: activeSpot.radius,
            }}
          />

          <div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={bodyId}
            tabIndex={-1}
            className="bezel pointer-events-auto fixed outline-none"
            style={{
              left: 0,
              top: 0,
              width: `min(${CARD_MAX_W}px, calc(100vw - ${EDGE * 2}px))`,
              transform: `translate3d(${Math.round(cardPos.x)}px, ${Math.round(
                cardPos.y,
              )}px, 0)`,
              transition: reduceMotion
                ? 'none'
                : 'transform 460ms cubic-bezier(0.32, 0.72, 0, 1)',
            }}
          >
            <div className="bezel-core p-5">
              {/* Keyed on the step so the content remounts and re-runs the
                  cross-fade. `tour-card-in` is a no-op under reduced motion. */}
              <div key={step.id} className={reduceMotion ? undefined : 'tour-card-in'}>
                <div className="flex items-center justify-between gap-3">
                  <span className="eyebrow">{step.eyebrow}</span>
                  <span className="tabular text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {String(index + 1).padStart(2, '0')} /{' '}
                    {String(total).padStart(2, '0')}
                  </span>
                </div>

                <h2
                  id={titleId}
                  className="mt-2.5 font-display text-lg font-bold leading-tight tracking-tight"
                >
                  {step.title}
                </h2>
                <p
                  id={bodyId}
                  className="mt-2 text-sm leading-6 text-muted-foreground"
                >
                  {step.body}
                </p>
              </div>

              {/* Decorative: the "NN / NN" readout above is the accessible
                  progress indicator, so these are not extra tab stops. */}
              <div className="mt-4 flex items-center gap-1.5" aria-hidden>
                {TOUR_STEPS.map((dot, dotIndex) => (
                  <span
                    key={dot.id}
                    className={cn(
                      'h-1 rounded-full transition-[width,background-color] duration-300',
                      dotIndex === index
                        ? 'w-5 bg-primary'
                        : dotIndex < index
                          ? 'w-1.5 bg-primary/40'
                          : 'w-1.5 bg-white/15',
                    )}
                  />
                ))}
              </div>

              <div className="mt-4 flex items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={close}
                  className="-ml-2 text-muted-foreground hover:text-foreground"
                >
                  Skip tour
                </Button>

                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={goBack}
                    disabled={index === 0}
                    className="gap-1.5 bg-white/[0.03]"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={goNext}
                    className="gap-1.5"
                  >
                    {isLast ? 'Done' : 'Next'}
                    {isLast ? (
                      <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                    ) : (
                      <ArrowRight
                        className="h-3.5 w-3.5"
                        strokeWidth={2}
                        aria-hidden
                      />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      {/*
        Persistent replay control. Bottom-right, clear of the header brand mark
        and the right-hand eyebrow; it sits above the footer text and, on the
        idle screen, to the right of the mobile panel's own full-width buttons.
        It is also step 8's own anchor (`data-tour="replay"`).
      */}
      <button
        ref={replayRef}
        type="button"
        data-tour="replay"
        onClick={start}
        aria-label="Replay the tutorial"
        title="Replay the tutorial"
        className={cn(
          'fixed bottom-4 right-4 z-[110] inline-flex h-9 items-center gap-2 rounded-full',
          'border border-white/10 bg-card/85 px-3 text-xs font-semibold text-muted-foreground shadow-lg backdrop-blur',
          'transition-colors hover:border-primary/40 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <GraduationCap
          className="h-4 w-4 text-primary"
          strokeWidth={1.5}
          aria-hidden
        />
        <span className="hidden font-display sm:inline">Tutorial</span>
      </button>

      {overlay}
    </>
  );
}

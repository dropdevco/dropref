/**
 * Copy for the first-visit product tour.
 *
 * The clip limits are interpolated from `components/clip.ts` rather than typed
 * out, so the tour can never drift from the validator the uploader actually
 * enforces.
 */
import {
  MAX_SELECTION_S,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DURATION_S,
} from '@/components/clip';

const MAX_SOURCE_MB = Math.round(MAX_SOURCE_BYTES / (1024 * 1024));
const MAX_SOURCE_MIN = Math.round(MAX_SOURCE_DURATION_S / 60);

export type TourStep = {
  id: string;
  /**
   * The `data-tour` value of this step's anchor, or `null` for a step that is
   * deliberately centred with no spotlight (the welcome card).
   *
   * A non-null target is NOT a guarantee: on a genuine first visit there is no
   * clip loaded, so the editor anchors (`trim`, `transport`, `crop-zoom`) are
   * absent from the DOM. Those steps fall back to the same centred treatment —
   * blurred backdrop, no spotlight — so the copy still teaches the feature and
   * the step count stays stable. See ProductTour.
   */
  target: string | null;
  /** Small uppercase label above the heading. */
  eyebrow: string;
  title: string;
  body: string;
  /**
   * This step explains the clip editor, which does not exist in the DOM until a
   * clip is loaded. When true and no clip is present, `app/page.tsx` mounts
   * `TourDemoEditor` in the editor's slot so the step has something real to
   * spotlight instead of degrading to an unanchored card.
   */
  needsEditorDemo?: boolean;
};

export const TOUR_STEPS: TourStep[] = [
  {
    id: 'welcome',
    target: null,
    eyebrow: 'Welcome',
    title: 'A video assistant referee, on demand',
    body: 'RefCheck AI watches one passage of play and rules on it — a verdict, a confidence rating, and the rule it leaned on. This walkthrough takes about a minute.',
  },
  {
    id: 'upload',
    target: 'upload',
    eyebrow: 'Step one',
    title: 'Drop the clip in',
    body: `Drag an MP4, MOV or WebM onto the pad, or activate it to browse. A source file can run up to ${MAX_SOURCE_MB}MB and ${MAX_SOURCE_MIN} minutes — you narrow it to the moment next.`,
  },
  {
    id: 'trim',
    needsEditorDemo: true,
    target: 'trim',
    eyebrow: 'Step two',
    title: 'Trim to the moment',
    body: `Drag the two ends of the timeline around the play. Only the selection is encoded and analysed, and it can run up to ${MAX_SELECTION_S} seconds.`,
  },
  {
    id: 'transport',
    needsEditorDemo: true,
    target: 'stage',
    eyebrow: 'Step three',
    title: 'Work the playhead',
    body: 'Grab the video and drag sideways to jog it, hold Shift for fine control, or pinch with two fingers to scrub. The step buttons move a single frame, Space plays and pauses, and the 0.25× / 0.5× / 1× chips set playback speed.',
  },
  {
    id: 'crop-zoom',
    needsEditorDemo: true,
    target: 'crop-zoom',
    eyebrow: 'Step four',
    title: 'Reframe the play',
    body: 'Crop puts eight handles on the frame so you can box in the incident; Zoom pinches or scrolls it in and out. After either edit, set the video so the reframed clip is what gets sent.',
  },
  {
    id: 'sport',
    target: 'sport',
    eyebrow: 'Step five',
    title: 'Give it the context',
    body: 'Pick the sport so the right rulebook is loaded — soccer, football or lacrosse. Underneath, you can optionally type what the referee actually called, and the verdict is weighed against it.',
  },
  {
    id: 'analyze',
    target: 'analyze',
    eyebrow: 'Step six',
    title: 'Check the call',
    body: 'One press sends the selection for review. Back comes a verdict, a confidence rating, the reasoning behind it, and every rule cited with a link straight to the official rulebook.',
  },
  {
    id: 'replay',
    target: 'replay',
    eyebrow: 'Anytime',
    title: 'Run it back',
    body: 'This control reopens the walkthrough whenever you want it. Nothing you have already set up is cleared.',
  },
];

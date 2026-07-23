import type { SportId } from '@/types/contract';

/**
 * OWNER: Dev A (frontend).
 *
 * Single source of truth for the sport picker AND the sample-clip row.
 * Adding a sport to the UI is ONE entry here (Dev B adds the matching
 * `/data/sports/{id}.json`). No other frontend changes required.
 *
 * `samples[].src` points at files under /public/samples — the actual clips
 * get dropped in later; the UI references them by path.
 */
export interface SportSample {
  label: string;
  src: string;
}

export interface SportOption {
  id: SportId;
  label: string;
  emoji: string;
  samples: SportSample[];
}

export const SPORTS: SportOption[] = [
  {
    id: 'soccer',
    label: 'Soccer',
    emoji: '⚽',
    samples: [
      { label: 'Offside goal', src: '/samples/soccer-offside.mp4' },
      { label: 'Penalty box tackle', src: '/samples/soccer-penalty.mp4' },
    ],
  },
  {
    id: 'football',
    label: 'Football',
    emoji: '🏈',
    samples: [
      { label: 'Pass interference', src: '/samples/football-pi.mp4' },
      { label: 'Goal-line fumble', src: '/samples/football-fumble.mp4' },
    ],
  },
  {
    id: 'lacrosse',
    label: 'Lacrosse',
    emoji: '🥍',
    samples: [
      { label: 'Slashing check', src: '/samples/lacrosse-slash.mp4' },
      { label: 'Crease violation', src: '/samples/lacrosse-crease.mp4' },
    ],
  },
];

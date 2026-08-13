import type { CouncilConfig, CouncilSeat } from './types';

/**
 * Seat roster and config factory.
 *
 * The panel is deliberately built from three DIFFERENT cheap models wearing
 * three DIFFERENT lenses. Same-model seats produce correlated answers, and
 * correlated answers make `consensusRatio` meaningless — it would measure
 * sampling noise rather than genuine agreement. The chair sits on a stronger
 * model because it is only invoked on the hard, already-split minority of runs.
 *
 * Every model slug is overridable by env var (see `.env.example`).
 */

const DEFAULT_SEAT_MODELS = [
  'google/gemini-2.5-flash',
  'openai/gpt-4o-mini',
  'anthropic/claude-haiku-4.5',
] as const;

const DEFAULT_CHAIR_MODEL = 'anthropic/claude-opus-4.5';

/** Used by client.ts when a seat's own model is unusable (bad id, no credits). */
const DEFAULT_FALLBACK_MODEL = 'openai/gpt-4o-mini';

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/** Model tried when a seat's primary model returns a model-specific error. */
export function fallbackModel(): string {
  return envStr('COUNCIL_FALLBACK_MODEL', DEFAULT_FALLBACK_MODEL);
}

/**
 * Default panel.
 *
 * Temperatures are staggered on purpose: the adversarial seats get a little
 * more room to construct their case, the literalist stays near-deterministic
 * because its job is to read the rule text back accurately.
 */
export function defaultSeats(): CouncilSeat[] {
  return [
    {
      id: 'seat-1',
      model: envStr('COUNCIL_SEAT_1_MODEL', DEFAULT_SEAT_MODELS[0]),
      role: 'literalist',
      temperature: 0.1,
    },
    {
      id: 'seat-2',
      model: envStr('COUNCIL_SEAT_2_MODEL', DEFAULT_SEAT_MODELS[1]),
      role: 'prosecutor',
      temperature: 0.4,
    },
    {
      id: 'seat-3',
      model: envStr('COUNCIL_SEAT_3_MODEL', DEFAULT_SEAT_MODELS[2]),
      role: 'defender',
      temperature: 0.4,
    },
  ];
}

/**
 * Extra seats available for a wider council. Not in the default roster — a
 * 5-seat panel costs ~65% more per request for a distribution that is rarely
 * decisive at this corpus size — but exposed so the eval harness can sweep it.
 */
export function extendedSeats(): CouncilSeat[] {
  return [
    ...defaultSeats(),
    {
      id: 'seat-4',
      model: envStr('COUNCIL_SEAT_4_MODEL', 'mistralai/mistral-small-3.2-24b-instruct'),
      role: 'skeptic',
      temperature: 0.2,
    },
    {
      id: 'seat-5',
      model: envStr('COUNCIL_SEAT_5_MODEL', 'meta-llama/llama-3.3-70b-instruct'),
      role: 'contextualist',
      temperature: 0.3,
    },
  ];
}

export function defaultChair(): CouncilSeat {
  return {
    id: 'chair',
    model: envStr('COUNCIL_CHAIR_MODEL', DEFAULT_CHAIR_MODEL),
    role: 'chair',
    temperature: 0.1,
  };
}

/**
 * Escalation cut-points.
 *
 * `consensusThreshold` 0.75 sits strictly between 2/3 and 1, so for the default
 * 3-seat panel it means "unanimous": one live dissent is exactly the signal
 * worth spending a debate round on, and the debate round is three more CHEAP
 * calls, not a chair call. For a 4-seat panel it reads as "at least 3 of 4".
 *
 * `minProbability` 0.65 is the second gate: a unanimous panel that is
 * collectively unsure still escalates, because unanimity among three hedging
 * models is agreement about not knowing, not agreement about the answer. 0.65
 * is the MEDIUM band midpoint, so "all three said MEDIUM" passes and "all three
 * said LOW" does not.
 *
 * `quorum` 2 keeps a 3-seat panel alive through one provider outage; below two
 * seats there is no agreement to measure and the council has nothing to add.
 */
export const DEFAULT_CONSENSUS_THRESHOLD = 0.75;
export const DEFAULT_MIN_PROBABILITY = 0.65;
export const DEFAULT_QUORUM = 2;
export const DEFAULT_TIMEOUT_MS = 45_000;

export function defaultCouncilConfig(
  overrides: Partial<CouncilConfig> = {},
): CouncilConfig {
  return {
    seats: defaultSeats(),
    chair: defaultChair(),
    consensusThreshold: envNum(
      'COUNCIL_CONSENSUS_THRESHOLD',
      DEFAULT_CONSENSUS_THRESHOLD,
    ),
    minProbability: envNum('COUNCIL_MIN_PROBABILITY', DEFAULT_MIN_PROBABILITY),
    quorum: envNum('COUNCIL_QUORUM', DEFAULT_QUORUM),
    timeoutMs: envNum('COUNCIL_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
    enabled: envBool('COUNCIL_ENABLED', true),
    ...overrides,
  };
}

/**
 * Baseline arm of the A/B: one seat, one call. Uses the first panel model so
 * the comparison isolates the council MECHANISM rather than a model upgrade.
 */
export function baselineSeat(config?: CouncilConfig): CouncilSeat {
  const seat = config?.seats[0] ?? defaultSeats()[0];
  return { ...seat, id: 'baseline', role: 'contextualist' };
}

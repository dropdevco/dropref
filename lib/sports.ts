import type { SportCorpus, SportId } from '@/types/contract';

/**
 * OWNER: Dev B (AI pipeline).
 *
 * WHAT IT MUST DO:
 *   Load the rulebook corpus for a sport from `/data/sports/{id}.json`.
 *   Lookup is BY FILENAME ONLY. Adding a new sport must be a new JSON file
 *   and ZERO code changes here — do not add per-sport branches or switch
 *   statements. Parse/validate the JSON against the SportCorpus shape.
 *
 * WHAT IT MUST RETURN:
 *   A fully-populated `SportCorpus` for the given id. Throw if the file is
 *   missing or malformed (the route maps thrown errors to MODEL_ERROR, and
 *   an unknown sport is already rejected upstream as UNSUPPORTED_SPORT).
 */
export function getSport(_id: SportId): SportCorpus {
  throw new Error('NOT_IMPLEMENTED: Dev B');
}

import fs from 'fs';
import path from 'path';
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
export function getSport(id: SportId): SportCorpus {
  try {
    const filePath = path.join(process.cwd(), 'data', 'sports', `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Sport rulebook file not found for ID: ${id}`);
    }
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const corpus = JSON.parse(fileContent) as SportCorpus;
    
    // Basic structural validation
    if (!corpus.id || !corpus.displayName || !Array.isArray(corpus.rules)) {
      throw new Error(`Sport rulebook file at ${id}.json is malformed.`);
    }
    
    return corpus;
  } catch (error) {
    throw new Error(`Failed to load sport corpus for ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

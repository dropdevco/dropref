import fs from 'fs';
import path from 'path';
import { SportCorpus, SportId } from '../types/contract';

export function getSportCorpus(id: SportId): SportCorpus {
  const filePath = path.join(process.cwd(), 'backend', 'data', 'sports', `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Corpus for sport ${id} not found.`);
  }
  const fileContents = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(fileContents) as SportCorpus;
}

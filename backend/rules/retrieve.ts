import Fuse from 'fuse.js';
import { SportCorpus, CitedRule, SportRule } from '../../types/contract';

export function retrieveRules(corpus: SportCorpus, description: string, maxResults: number = 5): CitedRule[] {
  const options = {
    keys: [
      { name: 'keywords', weight: 3 },
      { name: 'title', weight: 2 },
      { name: 'text', weight: 1 }
    ],
    threshold: 0.4,
    ignoreLocation: true,
  };

  const fuse = new Fuse(corpus.rules, options);
  
  // Create a query based on the description. 
  // In a real scenario we might extract keywords from the description first,
  // but for Fuse.js we can pass the description if it's not too long, 
  // or we can use a simpler approach. Let's pass the description directly.
  const results = fuse.search(description);
  
  return results.slice(0, maxResults).map(result => ({
    code: result.item.code,
    title: result.item.title,
    text: result.item.text,
  }));
}

export function filterValidRuleCodes(corpus: SportCorpus, codes: string[]): string[] {
  const validCodes = new Set(corpus.rules.map((r: SportRule) => r.code));
  const filtered = codes.filter(code => {
    if (validCodes.has(code)) return true;
    console.warn(`[RefCheck AI] Model cited invalid rule code: ${code}`);
    return false;
  });
  return filtered;
}

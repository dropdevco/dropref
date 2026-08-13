/**
 * Entry point for the accuracy harness.
 *
 *   npx tsx backend/eval/cli.ts [--sport=soccer] [--limit=N] [--arms=baseline,council] [--concurrency=4] [--out=path]
 *
 * This is the ONLY file allowed to touch the real council implementation, and
 * it does so with a lazy dynamic import inside the command handler — so
 * metrics.ts / runner.ts / report.ts stay importable and testable offline while
 * backend/council/index.ts is still being written.
 *
 * Exits 1 when the report verdict is COUNCIL_WORSE, so this doubles as a
 * regression gate in CI.
 */

import fs from 'fs';
import path from 'path';
import type { SportId } from '../../types/contract';
import type { CouncilInput, CouncilResult } from '../council/types';
import { aggregate, compare } from './metrics';
import type { ArmName } from './metrics';
import { renderConsole, renderMarkdown } from './report';
import type { Arm } from './runner';
import {
  ALL_SPORTS,
  RESULTS_DIR,
  casesOf,
  errorMessage,
  goldenVersionOf,
  loadGoldenSets,
  runArm,
} from './runner';
import type { CaseOutcome } from './types';

const USAGE = `
Usage: npx tsx backend/eval/cli.ts [options]

Options:
  --sport=soccer[,football]   Restrict to these sports (default: all golden sets found)
  --limit=N                   Only run the first N cases after ordering (smoke run)
  --arms=baseline,council     Which arms to run (default: baseline,council)
  --concurrency=4             Max in-flight cases per arm (default: 4)
  --seed=N                    Deterministic case ordering / subset selection
  --k=5                       Retrieval shortlist size (default: 5, matches the pipeline)
  --out=path                  Results directory (default: backend/eval/results)
  --no-cache                  Ignore and do not write the resume cache
  --help                      Show this message
`.trim();

// ---------------------------------------------------------------------------
// .env (tiny inline parser — dotenv is not in node_modules and adding a
// dependency for ~15 lines of KEY=VALUE parsing is not worth it)
// ---------------------------------------------------------------------------

function loadDotEnv(envPath = path.join(process.cwd(), '.env')): void {
  if (!fs.existsSync(envPath)) return;
  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    // Real environment always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface CliArgs {
  sports: SportId[];
  limit?: number;
  arms: ArmName[];
  concurrency: number;
  seed?: number;
  k: number;
  outDir: string;
  cache: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.set(body, 'true');
    else flags.set(body.slice(0, eq), body.slice(eq + 1));
  }

  const sportsRaw = flags.get('sport') ?? flags.get('sports');
  const sports = sportsRaw
    ? sportsRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is SportId => (ALL_SPORTS as string[]).includes(s))
    : [];
  if (sportsRaw && sports.length === 0) {
    throw new Error(`--sport must be one or more of: ${ALL_SPORTS.join(', ')}`);
  }

  const armsRaw = flags.get('arms') ?? 'baseline,council';
  const arms = armsRaw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is ArmName => s === 'baseline' || s === 'council');
  if (arms.length === 0) throw new Error('--arms must include baseline and/or council');

  const intFlag = (name: string): number | undefined => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
    return n;
  };

  return {
    sports,
    limit: intFlag('limit'),
    arms,
    concurrency: intFlag('concurrency') ?? 4,
    seed: intFlag('seed'),
    k: intFlag('k') ?? 5,
    outDir: flags.get('out') ?? RESULTS_DIR,
    cache: !flags.has('no-cache'),
    help: flags.has('help') || flags.has('h'),
  };
}

// ---------------------------------------------------------------------------
// Lazy council import
// ---------------------------------------------------------------------------

interface CouncilModule {
  runCouncil?: (input: CouncilInput, ...rest: unknown[]) => Promise<CouncilResult>;
  runSingleModel?: (input: CouncilInput, ...rest: unknown[]) => Promise<CouncilResult>;
}

/**
 * Resolved at call time through a non-literal specifier, so `tsc` never tries
 * to type-check a module that another agent may not have written yet, and so
 * importing anything else in backend/eval never pulls in the network layer.
 */
async function loadCouncilModule(): Promise<CouncilModule> {
  const specifier = '../council/index';
  try {
    const mod = (await import(specifier)) as CouncilModule & { default?: CouncilModule };
    return (mod.default ?? mod) as CouncilModule;
  } catch (err) {
    throw new Error(
      `Could not load backend/council/index.ts (${errorMessage(err)}).\n` +
        `The harness itself is fine — it just has no arms to run yet. ` +
        `Once runCouncil/runSingleModel are exported from backend/council/index.ts, re-run this command.`,
    );
  }
}

function resolveArm(mod: CouncilModule, name: ArmName): Arm {
  const fn = name === 'council' ? mod.runCouncil : mod.runSingleModel;
  if (typeof fn !== 'function') {
    const expected = name === 'council' ? 'runCouncil' : 'runSingleModel';
    throw new Error(`backend/council/index.ts does not export a function named "${expected}".`);
  }
  return (input: CouncilInput) => fn(input);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function timestampSlug(iso: string): string {
  return iso.replace(/[:.]/g, '-');
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[eval] ${errorMessage(err)}\n\n${USAGE}\n`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  loadDotEnv();

  if (!process.env.OPENROUTER_API_KEY) {
    process.stderr.write(
      '[eval] OPENROUTER_API_KEY is not set.\n' +
        `[eval] Add it to ${path.join(process.cwd(), '.env')} or export it in your shell.\n` +
        '[eval] Refusing to run: without a key every case would error and the report ' +
        'would be meaningless numbers over zero scored cases.\n',
    );
    return 1;
  }

  const sets = loadGoldenSets(args.sports.length > 0 ? args.sports : undefined);
  const cases = casesOf(sets);
  if (cases.length === 0) {
    process.stderr.write(
      '[eval] No golden cases loaded — nothing to evaluate. ' +
        'See the messages above for the paths that were checked.\n',
    );
    return 1;
  }
  const goldenVersion = goldenVersionOf(sets);
  const sports = [...new Set(sets.map((s) => s.sport))];

  let mod: CouncilModule;
  try {
    mod = await loadCouncilModule();
  } catch (err) {
    process.stderr.write(`[eval] ${errorMessage(err)}\n`);
    return 1;
  }

  const cachePath = args.cache ? path.join(args.outDir, '.run-cache.json') : null;
  const outcomesByArm = new Map<ArmName, CaseOutcome[]>();

  for (const armName of args.arms) {
    let armFn: Arm;
    try {
      armFn = resolveArm(mod, armName);
    } catch (err) {
      process.stderr.write(`[eval] ${errorMessage(err)}\n`);
      return 1;
    }
    const outcomes = await runArm(armFn, cases, {
      arm: armName,
      concurrency: args.concurrency,
      k: args.k,
      limit: args.limit,
      seed: args.seed,
      goldenVersion,
      cachePath,
    });
    outcomesByArm.set(armName, outcomes);
  }

  fs.mkdirSync(args.outDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const stamp = timestampSlug(generatedAt);

  const baselineOutcomes = outcomesByArm.get('baseline') ?? [];
  const councilOutcomes = outcomesByArm.get('council') ?? [];

  // A single-arm run cannot answer the comparison question, so it deliberately
  // does NOT fabricate a ComparisonReport with an empty opposing arm — that
  // would print a fake +100pp delta. It reports that arm's metrics and stops.
  if (args.arms.length < 2) {
    const only = args.arms[0];
    const metrics = aggregate(outcomesByArm.get(only) ?? [], only);
    const jsonPath = path.join(args.outDir, `arm-${only}-${stamp}.json`);
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({ generatedAt, goldenVersion, sports, metrics, outcomes: outcomesByArm.get(only) }, null, 2),
      'utf8',
    );
    process.stdout.write(
      `\nSingle-arm run (${only}) — no comparison possible.\n` +
        `  n                 : ${metrics.n}\n` +
        `  verdict accuracy  : ${(metrics.verdictAccuracy * 100).toFixed(1)}%\n` +
        `  macro-F1          : ${metrics.macroF1.toFixed(3)}\n` +
        `  mean rule F1      : ${metrics.meanRuleF1.toFixed(3)}\n` +
        `  retrieval hit rate: ${(metrics.retrievalHitRate * 100).toFixed(1)}%\n` +
        `  ECE / Brier       : ${metrics.ece.toFixed(3)} / ${metrics.brier.toFixed(3)}\n` +
        `  error rate        : ${(metrics.errorRate * 100).toFixed(1)}%\n` +
        `\nWrote ${jsonPath}\n` +
        `Run with --arms=baseline,council to get a significance-tested comparison.\n`,
    );
    return 0;
  }

  const report = compare(
    aggregate(baselineOutcomes, 'baseline'),
    aggregate(councilOutcomes, 'council'),
    baselineOutcomes,
    councilOutcomes,
    { goldenVersion, sports, generatedAt },
  );

  const jsonPath = path.join(args.outDir, `comparison-${stamp}.json`);
  const mdPath = path.join(args.outDir, `comparison-${stamp}.md`);
  const latestJson = path.join(args.outDir, 'latest.json');
  const latestMd = path.join(args.outDir, 'latest.md');
  const markdown = renderMarkdown(report);
  const payload = JSON.stringify(
    { report, outcomes: { baseline: baselineOutcomes, council: councilOutcomes } },
    null,
    2,
  );

  fs.writeFileSync(jsonPath, payload, 'utf8');
  fs.writeFileSync(mdPath, markdown, 'utf8');
  fs.writeFileSync(latestJson, payload, 'utf8');
  fs.writeFileSync(latestMd, markdown, 'utf8');

  process.stdout.write(`\n${renderConsole(report)}\n`);
  process.stdout.write(`\nWrote:\n  ${jsonPath}\n  ${mdPath}\n  ${latestJson}\n  ${latestMd}\n`);

  // Regression gate: a significant regression fails the command.
  return report.verdict === 'COUNCIL_WORSE' ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`[eval] fatal: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });

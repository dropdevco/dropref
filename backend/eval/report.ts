/**
 * Renders a ComparisonReport for humans: plain-text for the console, markdown
 * for the results directory / PR comments.
 *
 * Pure string formatting — no I/O, so it can be snapshot-tested offline.
 */

import type { ComparisonReport } from './types';
import { DIFFICULTIES, VERDICT_CLASSES } from './metrics';

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pp = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pp`;
const num = (x: number, digits = 3): string => x.toFixed(digits);
const signed = (x: number, digits = 3): string => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
const ms = (x: number): string => `${Math.round(x)}ms`;

/** p-values below 1e-4 are more honestly shown in scientific notation. */
function formatP(p: number): string {
  if (p >= 0.0001) return p.toFixed(5);
  return p.toExponential(2);
}

const VERDICT_BANNER: Record<ComparisonReport['verdict'], string> = {
  COUNCIL_BETTER: 'COUNCIL IS BETTER (significant)',
  NO_SIGNIFICANT_DIFFERENCE: 'NO SIGNIFICANT DIFFERENCE',
  COUNCIL_WORSE: 'COUNCIL IS WORSE (significant regression)',
};

/** One-line plain-English reading of the significance result. */
export function significanceSentence(report: ComparisonReport): string {
  const { baselineOnlyCorrect: b, councilOnlyCorrect: c, pValue, significant } = report.significance;
  const discordant = b + c;
  if (discordant === 0) {
    return 'The two arms agreed on every scored case, so there is nothing to test (p = 1).';
  }
  const direction =
    report.delta.verdictAccuracy > 0
      ? 'in the council’s favour'
      : report.delta.verdictAccuracy < 0
        ? 'against the council'
        : 'in neither direction';
  return significant
    ? `Of ${discordant} disagreements the council fixed ${c} and broke ${b}; ` +
        `exact McNemar p = ${formatP(pValue)}, so the difference ${direction} is unlikely to be noise.`
    : `Of ${discordant} disagreements the council fixed ${c} and broke ${b}; ` +
        `exact McNemar p = ${formatP(pValue)} (>= 0.05), so this is indistinguishable from noise. ` +
        `A raw delta of ${pp(report.delta.verdictAccuracy)} is NOT evidence of an improvement.`;
}

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}
function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Fixed-width table for console output. */
function textTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[], padder: (s: string, w: number) => string): string =>
    cells.map((c, i) => padder(c ?? '', widths[i])).join('  ');
  const out = [line(headers, padRight), widths.map((w) => '-'.repeat(w)).join('  ')];
  for (const row of rows) {
    out.push(
      row
        .map((c, i) => (i === 0 ? padRight(c ?? '', widths[i]) : padLeft(c ?? '', widths[i])))
        .join('  '),
    );
  }
  return out.join('\n');
}

function mdTable(headers: string[], rows: string[][]): string {
  const out = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map((_, i) => (i === 0 ? ':---' : '---:')).join(' | ')} |`,
  ];
  for (const row of rows) out.push(`| ${row.join(' | ')} |`);
  return out.join('\n');
}

/** Rows shared by both renderers: metric, baseline, council, delta. */
function headlineRows(report: ComparisonReport): string[][] {
  const { baseline: b, council: c, delta: d } = report;
  return [
    ['Verdict accuracy', pct(b.verdictAccuracy), pct(c.verdictAccuracy), pp(d.verdictAccuracy)],
    ['Macro-F1', num(b.macroF1), num(c.macroF1), signed(d.macroF1)],
    ['Mean rule F1', num(b.meanRuleF1), num(c.meanRuleF1), signed(d.meanRuleF1)],
    ['Mean rule precision', num(b.meanRulePrecision), num(c.meanRulePrecision), '-'],
    ['Mean rule recall', num(b.meanRuleRecall), num(c.meanRuleRecall), '-'],
    ['Retrieval hit rate', pct(b.retrievalHitRate), pct(c.retrievalHitRate), '-'],
    ['ECE (lower better)', num(b.ece), num(c.ece), signed(d.ece)],
    ['Brier (lower better)', num(b.brier), num(c.brier), signed(c.brier - b.brier)],
    ['Mean latency', ms(b.meanLatencyMs), ms(c.meanLatencyMs), `${d.meanLatencyMs >= 0 ? '+' : ''}${ms(d.meanLatencyMs)}`],
    [
      'Total model calls',
      String(b.totalModelCalls),
      String(c.totalModelCalls),
      `${d.totalModelCalls >= 0 ? '+' : ''}${d.totalModelCalls}`,
    ],
    ['Error rate', pct(b.errorRate), pct(c.errorRate), '-'],
    ['Cases (n)', String(b.n), String(c.n), '-'],
  ];
}

function perVerdictRows(report: ComparisonReport): string[][] {
  return VERDICT_CLASSES.map((cls) => {
    const b = report.baseline.perVerdict[cls];
    const c = report.council.perVerdict[cls];
    return [
      cls,
      String(b?.support ?? 0),
      num(b?.f1 ?? 0),
      num(c?.f1 ?? 0),
      signed((c?.f1 ?? 0) - (b?.f1 ?? 0)),
    ];
  });
}

function difficultyRows(report: ComparisonReport): string[][] {
  return DIFFICULTIES.map((band) => {
    const b = report.baseline.accuracyByDifficulty[band];
    const c = report.council.accuracyByDifficulty[band];
    return [
      band,
      String(b?.n ?? 0),
      pct(b?.accuracy ?? 0),
      pct(c?.accuracy ?? 0),
      pp((c?.accuracy ?? 0) - (b?.accuracy ?? 0)),
    ];
  });
}

function idList(ids: string[], max = 25): string {
  if (ids.length === 0) return '(none)';
  const head = ids.slice(0, max).join(', ');
  return ids.length > max ? `${head}, … (+${ids.length - max} more)` : head;
}

/** Human-readable console rendering. */
export function renderConsole(report: ComparisonReport): string {
  const bar = '='.repeat(72);
  const lines: string[] = [];

  lines.push(bar);
  lines.push('  RefCheck AI — council vs. single-model baseline');
  lines.push(bar);
  lines.push(`  golden set : ${report.goldenVersion}`);
  lines.push(`  sports     : ${report.sports.join(', ') || '(none)'}`);
  lines.push(`  generated  : ${report.generatedAt}`);
  lines.push('');
  lines.push(`  VERDICT: ${VERDICT_BANNER[report.verdict]}`);
  lines.push('');
  lines.push(`  ${significanceSentence(report)}`);
  lines.push('');
  lines.push(textTable(['Metric', 'Baseline', 'Council', 'Delta'], headlineRows(report)));
  lines.push('');
  lines.push('  Per-verdict F1');
  lines.push(
    textTable(['Class', 'Support', 'Base F1', 'Council F1', 'Delta'], perVerdictRows(report)),
  );
  lines.push('');
  lines.push('  Accuracy by difficulty');
  lines.push(textTable(['Difficulty', 'n', 'Baseline', 'Council', 'Delta'], difficultyRows(report)));
  lines.push('');
  lines.push('  McNemar (exact two-sided binomial)');
  lines.push(`    baseline-only correct (b) : ${report.significance.baselineOnlyCorrect}`);
  lines.push(`    council-only correct  (c) : ${report.significance.councilOnlyCorrect}`);
  lines.push(`    p-value                   : ${formatP(report.significance.pValue)}`);
  lines.push(`    significant (p < 0.05)    : ${report.significance.significant ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push(`  Fixes (${report.fixes.length}): ${idList(report.fixes)}`);
  lines.push(`  Regressions (${report.regressions.length}): ${idList(report.regressions)}`);
  lines.push(bar);
  return lines.join('\n');
}

/** Markdown rendering, suitable for the results dir or a PR comment. */
export function renderMarkdown(report: ComparisonReport): string {
  const lines: string[] = [];

  lines.push('# RefCheck AI — council vs. single-model baseline');
  lines.push('');
  lines.push(`**Verdict: \`${report.verdict}\`** — ${VERDICT_BANNER[report.verdict]}`);
  lines.push('');
  lines.push(significanceSentence(report));
  lines.push('');
  lines.push(`- Golden set: \`${report.goldenVersion}\``);
  lines.push(`- Sports: ${report.sports.join(', ') || '(none)'}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Headline metrics');
  lines.push('');
  lines.push(mdTable(['Metric', 'Baseline', 'Council', 'Delta'], headlineRows(report)));
  lines.push('');
  lines.push('## Per-verdict F1');
  lines.push('');
  lines.push(
    mdTable(['Class', 'Support', 'Baseline F1', 'Council F1', 'Delta'], perVerdictRows(report)),
  );
  lines.push('');
  lines.push('## Accuracy by difficulty');
  lines.push('');
  lines.push(mdTable(['Difficulty', 'n', 'Baseline', 'Council', 'Delta'], difficultyRows(report)));
  lines.push('');
  lines.push('## Significance — McNemar exact two-sided binomial test');
  lines.push('');
  lines.push(
    mdTable(
      ['Quantity', 'Value'],
      [
        ['Baseline-only correct (b)', String(report.significance.baselineOnlyCorrect)],
        ['Council-only correct (c)', String(report.significance.councilOnlyCorrect)],
        ['p-value', formatP(report.significance.pValue)],
        ['Significant (p < 0.05)', report.significance.significant ? 'yes' : 'no'],
      ],
    ),
  );
  lines.push('');
  lines.push(
    'The exact binomial test is used rather than the chi-squared approximation: ' +
      'the discordant count on a set this size is small, and the approximation is ' +
      'unreliable there.',
  );
  lines.push('');
  lines.push(`## Fixes (${report.fixes.length})`);
  lines.push('');
  lines.push(report.fixes.length ? report.fixes.map((id) => `- \`${id}\``).join('\n') : '_none_');
  lines.push('');
  lines.push(`## Regressions (${report.regressions.length})`);
  lines.push('');
  lines.push(
    report.regressions.length
      ? report.regressions.map((id) => `- \`${id}\``).join('\n')
      : '_none_',
  );
  lines.push('');
  return lines.join('\n');
}

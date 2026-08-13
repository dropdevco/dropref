/**
 * Renders a ComparisonReport for humans: plain-text for the console, markdown
 * for the results directory / PR comments.
 *
 * Pure string formatting — no I/O, so it can be snapshot-tested offline.
 *
 * LAYOUT RULE (defect B2): the comparison table contains ONLY paired figures,
 * and its header says so with the intersection size in it. The per-arm figures
 * live in a separate, clearly-titled table down beside `errorRate`, with no
 * delta column at all — there is nothing there to subtract. The two tables can
 * never be read as the same numbers because they never share a heading, a
 * column set, or a denominator caption.
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

/**
 * One-line reading of the pairing. Printed directly under the banner, because
 * the size of the gap between the paired and per-arm deltas is the single most
 * load-bearing fact about whether the headline can be trusted.
 */
export function pairingSentence(report: ComparisonReport): string {
  const p = report.pairing;
  const dropped =
    p.erroredCaseIds.baselineOnly.length +
    p.erroredCaseIds.councilOnly.length +
    p.erroredCaseIds.both.length;
  const base =
    `Every headline figure is computed on the ${p.pairedCases}-case PAIRED INTERSECTION ` +
    `(cases both arms scored). ${dropped} case(s) were dropped for an arm error and ` +
    `${p.unpairedCaseIds.length} were run by only one arm.`;
  if (dropped === 0 && p.unpairedCaseIds.length === 0) {
    return `${base} Both arms scored every case, so the per-arm figures coincide with the paired ones here.`;
  }
  return (
    `${base} On per-arm denominators the accuracy delta would read ` +
    `${pp(p.unpairedAccuracyDelta)} instead of ${pp(p.pairedAccuracyDelta)} — a ` +
    `${pp(p.unpairedAccuracyDelta - p.pairedAccuracyDelta)} artefact of the differing ` +
    `denominators, not an effect of the council.`
  );
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

/** Column headers for the paired table. The denominator is IN the header. */
export function pairedHeaders(report: ComparisonReport): string[] {
  const n = report.pairing.pairedCases;
  return ['Metric (PAIRED, n=' + n + ')', 'Baseline', 'Council', 'Delta'];
}

/**
 * Rows shared by both renderers: metric, baseline, council, delta.
 * PAIRED ONLY. Nothing in here is on a per-arm denominator.
 */
function headlineRows(report: ComparisonReport): string[][] {
  const { baseline: b, council: c, delta: d } = report;
  return [
    ['Verdict accuracy', pct(b.verdictAccuracy), pct(c.verdictAccuracy), pp(d.verdictAccuracy)],
    ['Macro-F1', num(b.macroF1), num(c.macroF1), signed(d.macroF1)],
    ['AUROC (discrimination)', num(b.auroc), num(c.auroc), signed(d.auroc)],
    ['Mean rule F1', num(b.meanRuleF1), num(c.meanRuleF1), signed(d.meanRuleF1)],
    ['Mean rule precision', num(b.meanRulePrecision), num(c.meanRulePrecision), '-'],
    ['Mean rule recall', num(b.meanRuleRecall), num(c.meanRuleRecall), '-'],
    ['ECE raw [1][2]', num(b.eceRaw), num(c.eceRaw), signed(d.eceRaw)],
    ['ECE recalibrated [1]', num(b.eceRecalibrated), num(c.eceRecalibrated), signed(d.eceRecalibrated)],
    ['Brier raw [1][2]', num(b.brierRaw), num(c.brierRaw), signed(d.brierRaw)],
    ['Brier recalibrated [1]', num(b.brierRecalibrated), num(c.brierRecalibrated), signed(c.brierRecalibrated - b.brierRecalibrated)],
    ['Score kind [2]', String(b.scoreKind), String(c.scoreKind), '-'],
  ];
}

/** Cost rows. These describe the whole run, errors included — not the intersection. */
function costRows(report: ComparisonReport): string[][] {
  const { baseline: b, council: c, delta: d } = report;
  return [
    ['Mean latency', ms(b.meanLatencyMs), ms(c.meanLatencyMs), `${d.meanLatencyMs >= 0 ? '+' : ''}${ms(d.meanLatencyMs)}`],
    [
      'Total model calls',
      String(b.totalModelCalls),
      String(c.totalModelCalls),
      `${d.totalModelCalls >= 0 ? '+' : ''}${d.totalModelCalls}`,
    ],
    ['Cases attempted (n)', String(b.n), String(c.n), '-'],
  ];
}

/**
 * The per-arm figures. NO delta column, by design — subtracting these across
 * arms is defect B2, and the table gives you nothing to subtract with.
 */
function unpairedRows(report: ComparisonReport): string[][] {
  const b = report.baseline.unpaired;
  const c = report.council.unpaired;
  const val = <T>(x: T | undefined, f: (v: T) => string): string => (x === undefined ? 'n/a' : f(x));
  return [
    ['Error rate', pct(report.baseline.errorRate), pct(report.council.errorRate)],
    ['Own scored n (denominator)', val(b, (v) => String(v.scoredN)), val(c, (v) => String(v.scoredN))],
    ['Own verdict accuracy', val(b, (v) => pct(v.verdictAccuracy)), val(c, (v) => pct(v.verdictAccuracy))],
    ['Own macro-F1', val(b, (v) => num(v.macroF1)), val(c, (v) => num(v.macroF1))],
    ['Own AUROC', val(b, (v) => num(v.auroc)), val(c, (v) => num(v.auroc))],
    ['Own ECE raw', val(b, (v) => num(v.eceRaw)), val(c, (v) => num(v.eceRaw))],
    ['Own Brier raw', val(b, (v) => num(v.brierRaw)), val(c, (v) => num(v.brierRaw))],
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

function runMetadataRows(report: ComparisonReport): string[][] {
  const m = report.runMetadata;
  const rows: string[][] = [
    ['Retrieval hit rate (arm-independent)', pct(m.retrievalHitRate)],
    ['Paired cases (headline denominator)', String(report.pairing.pairedCases)],
    ['Dropped: baseline errored', String(report.pairing.erroredCaseIds.baselineOnly.length)],
    ['Dropped: council errored', String(report.pairing.erroredCaseIds.councilOnly.length)],
    ['Dropped: both errored', String(report.pairing.erroredCaseIds.both.length)],
    ['Dropped: run by one arm only', String(report.pairing.unpairedCaseIds.length)],
    ['Per-arm-denominator accuracy delta (WRONG)', pp(report.pairing.unpairedAccuracyDelta)],
    ['Paired accuracy delta (HONEST)', pp(report.pairing.pairedAccuracyDelta)],
  ];
  if (m.configFingerprint) rows.push(['Run config fingerprint', m.configFingerprint]);
  if (m.cacheHits) {
    rows.push([
      'Outcomes reused from cache (not re-invoked)',
      `baseline ${m.cacheHits.baseline}, council ${m.cacheHits.council}`,
    ]);
  }
  if (m.retrievalHitDisagreements.length > 0) {
    rows.push(['Retrieval-hit DISAGREEMENTS (should be 0)', String(m.retrievalHitDisagreements.length)]);
  }
  return rows;
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
  lines.push(`  ${pairingSentence(report)}`);
  lines.push('');
  lines.push(textTable(pairedHeaders(report), headlineRows(report)));
  lines.push('');
  lines.push('  Cost (whole run, errors included — NOT the paired intersection)');
  lines.push(textTable(['Metric', 'Baseline', 'Council', 'Delta'], costRows(report)));
  lines.push('');
  lines.push('  UNPAIRED per-arm figures — each on its OWN denominator.');
  lines.push('  NOT comparable across arms. Do not subtract these; that is the B2 defect.');
  lines.push(textTable(['Per-arm figure', 'Baseline', 'Council'], unpairedRows(report)));
  lines.push('');
  lines.push(`  Per-verdict F1 (paired, n=${report.pairing.pairedCases})`);
  lines.push(
    textTable(['Class', 'Support', 'Base F1', 'Council F1', 'Delta'], perVerdictRows(report)),
  );
  lines.push('');
  lines.push(`  Accuracy by difficulty (paired, n=${report.pairing.pairedCases})`);
  lines.push(textTable(['Difficulty', 'n', 'Baseline', 'Council', 'Delta'], difficultyRows(report)));
  lines.push('');
  lines.push('  Run metadata (properties of the RUN, not of either arm)');
  lines.push(textTable(['Quantity', 'Value'], runMetadataRows(report)));
  lines.push('');
  lines.push('  McNemar (exact two-sided binomial)');
  lines.push(`    baseline-only correct (b) : ${report.significance.baselineOnlyCorrect}`);
  lines.push(`    council-only correct  (c) : ${report.significance.councilOnlyCorrect}`);
  lines.push(`    p-value                   : ${formatP(report.significance.pValue)}`);
  lines.push(`    significant (p < 0.05)    : ${report.significance.significant ? 'YES' : 'NO'}`);
  lines.push('');
  lines.push(`  Fixes (${report.fixes.length}): ${idList(report.fixes)}`);
  lines.push(`  Regressions (${report.regressions.length}): ${idList(report.regressions)}`);
  lines.push('');
  lines.push('  CAVEATS');
  report.caveats.forEach((caveat, i) => {
    lines.push(`   [${i + 1}] ${caveat}`);
  });
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
  lines.push(pairingSentence(report));
  lines.push('');
  lines.push(`- Golden set: \`${report.goldenVersion}\``);
  lines.push(`- Sports: ${report.sports.join(', ') || '(none)'}`);
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`## Headline metrics — PAIRED INTERSECTION ONLY (n = ${report.pairing.pairedCases})`);
  lines.push('');
  lines.push(
    'Every number in this table is computed over the cases **both** arms scored. ' +
      'That is the only denominator on which a cross-arm delta means anything.',
  );
  lines.push('');
  lines.push(mdTable(pairedHeaders(report), headlineRows(report)));
  lines.push('');
  lines.push('## Cost (whole run, errors included)');
  lines.push('');
  lines.push(mdTable(['Metric', 'Baseline', 'Council', 'Delta'], costRows(report)));
  lines.push('');
  lines.push('## UNPAIRED per-arm figures — NOT comparable across arms');
  lines.push('');
  lines.push(
    'Each column below is on that arm\'s **own** scored set, so the two columns have ' +
      'different denominators. There is deliberately no delta column: subtracting these ' +
      'is what let a +7.3pp result be reported as +15.0pp.',
  );
  lines.push('');
  lines.push(mdTable(['Per-arm figure', 'Baseline', 'Council'], unpairedRows(report)));
  lines.push('');
  lines.push(`## Per-verdict F1 (paired, n = ${report.pairing.pairedCases})`);
  lines.push('');
  lines.push(
    mdTable(['Class', 'Support', 'Baseline F1', 'Council F1', 'Delta'], perVerdictRows(report)),
  );
  lines.push('');
  lines.push(`## Accuracy by difficulty (paired, n = ${report.pairing.pairedCases})`);
  lines.push('');
  lines.push(mdTable(['Difficulty', 'n', 'Baseline', 'Council', 'Delta'], difficultyRows(report)));
  lines.push('');
  lines.push('## Run metadata');
  lines.push('');
  lines.push(
    'Properties of the run, not of either arm. `retrievalHitRate` in particular depends ' +
      'only on the golden set and `prepareCase()`, which are identical for both arms — a ' +
      'do-nothing stub arm scores the same value and its delta is 0 by construction, which ' +
      'is why it is not in the comparison table.',
  );
  lines.push('');
  lines.push(mdTable(['Quantity', 'Value'], runMetadataRows(report)));
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
  lines.push('## Caveats');
  lines.push('');
  report.caveats.forEach((caveat, i) => {
    lines.push(`${i + 1}. ${caveat}`);
  });
  lines.push('');
  return lines.join('\n');
}

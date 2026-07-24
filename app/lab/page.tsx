'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  CircleCheck,
  Eye,
  Flag,
  FlaskConical,
  Gavel,
  KeyRound,
  Loader2,
  Scale,
  Search,
  Tag,
} from 'lucide-react';

import type { SportId, SportRule } from '@/types/contract';
import type { LabResult, Severity } from '@/lib/lab/adjudicate';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { SportSelector } from '@/components/sport-selector';
import { VerdictBadge } from '@/components/verdict-badge';
import { ConfidenceMeter } from '@/components/confidence-meter';

interface LabResponse {
  sport: SportId;
  displayName: string;
  totalRules: number;
  query: string;
  originalCall: string | null;
  k: number;
  matches: SportRule[];
  adjudicationAvailable: boolean;
  result: LabResult | null;
  modelUsed?: string;
  adjudicationError?: string;
}

const EXAMPLES: Record<SportId, { obs: string; call: string }[]> = {
  soccer: [
    {
      obs: 'At the moment the pass was played the striker was level with the last defender, then ran on to score.',
      call: 'Offside — goal disallowed',
    },
    {
      obs: 'The defender slid in from behind and caught the attacker on the ankle before touching the ball.',
      call: 'No foul — play on',
    },
    {
      obs: 'The ball struck the defender on the arm which was raised above the shoulder inside the box.',
      call: 'Penalty kick',
    },
  ],
  football: [
    {
      obs: 'The cornerback grabbed the receiver’s arm and turned early before the ball arrived downfield.',
      call: 'No flag',
    },
    {
      obs: 'The ball carrier’s knee was down before the ball came loose near the goal line.',
      call: 'Fumble, defense recovers',
    },
  ],
  lacrosse: [
    {
      obs: 'A one-handed uncontrolled swing of the stick struck the opponent across the back of the helmet.',
      call: 'No penalty',
    },
    {
      obs: 'The attacker’s foot stepped on the crease line before the ball crossed into the goal.',
      call: 'Goal counts',
    },
  ],
};

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );
}

/** Long rulebook text with a truncate + expand toggle. */
function RuleText({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const LIMIT = 240;
  const long = text.length > LIMIT;
  const shown = open || !long ? text : text.slice(0, LIMIT).trimEnd() + '…';
  return (
    <p className="mt-1.5 text-sm leading-relaxed text-foreground/70">
      {shown}
      {long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-1.5 rounded text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {open ? 'show less' : 'show full'}
        </button>
      )}
    </p>
  );
}

/* Ruling badge — the AI's own call when no referee call was supplied. */
const SEVERITY_META: Record<
  Severity,
  { tag: string; kind: 'card' | 'mark'; card?: string; accent: string }
> = {
  dismissal: {
    tag: 'Sending-off',
    kind: 'card',
    card: 'from-[hsl(0_80%_58%)] to-[hsl(0_74%_42%)] shadow-[0_18px_50px_-12px_hsl(0_78%_54%/0.7)]',
    accent: 'text-card_red text-glow-red',
  },
  caution: {
    tag: 'Caution',
    kind: 'card',
    card: 'from-[hsl(45_96%_58%)] to-[hsl(40_95%_46%)] shadow-[0_18px_50px_-12px_hsl(45_96%_54%/0.6)]',
    accent: 'text-card_yellow text-glow-yellow',
  },
  infringement: {
    tag: 'Infringement',
    kind: 'mark',
    accent: 'text-card_yellow',
  },
  'no-offence': {
    tag: 'Play on',
    kind: 'mark',
    accent: 'text-card_green text-glow-green',
  },
};

function RulingBadge({
  severity,
  decision,
}: {
  severity: Severity;
  decision: string;
}) {
  const m = SEVERITY_META[severity];
  return (
    <div className="flex flex-col items-center gap-4">
      {m.kind === 'card' ? (
        <div
          className={cn(
            'anim-sheen relative flex aspect-[5/7] w-24 -rotate-3 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br p-3 ring-1 ring-inset ring-white/25 motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:duration-500',
            m.card,
          )}
          aria-hidden
        >
          <span className="absolute inset-x-0 top-0 h-1/2 bg-white/10" />
          <span className="relative text-center font-display text-[11px] font-bold uppercase leading-tight tracking-wider text-black/80">
            {m.tag}
          </span>
        </div>
      ) : (
        <div className="relative grid place-items-center" aria-hidden>
          <span
            className={cn(
              'absolute h-14 w-14 rounded-full opacity-40 blur-md',
              severity === 'no-offence' ? 'bg-card_green' : 'bg-card_yellow',
            )}
          />
          {severity === 'no-offence' ? (
            <CircleCheck className="relative h-12 w-12 text-card_green" strokeWidth={1.5} />
          ) : (
            <Flag className="relative h-11 w-11 text-card_yellow" strokeWidth={1.5} />
          )}
        </div>
      )}
      <div className="text-center">
        <span className="eyebrow mb-1 justify-center">
          <Gavel className="h-3 w-3" strokeWidth={1.5} aria-hidden />
          AI ruling · {m.tag}
        </span>
        <h2
          className={cn(
            'text-balance font-display text-2xl font-bold tracking-tight sm:text-3xl',
            m.accent,
          )}
        >
          {decision}
        </h2>
      </div>
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Eye;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="eyebrow mb-2">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-foreground/80">{children}</p>
    </div>
  );
}

export default function RulebookLab() {
  const [sport, setSport] = useState<SportId | null>(null);
  const [query, setQuery] = useState('');
  const [originalCall, setOriginalCall] = useState('');
  const [k, setK] = useState(6);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<LabResponse | null>(null);

  const queryTokens = useMemo(() => tokenize(query), [query]);
  const canRun = Boolean(sport) && query.trim().length > 0 && !loading;

  async function run() {
    if (!sport || !query.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/rules-lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sport,
          query: query.trim(),
          originalCall: originalCall.trim() || undefined,
          k,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error ?? 'Request failed.');
        setData(null);
      } else {
        setData(body as LabResponse);
      }
    } catch {
      setError('Could not reach /api/rules-lab.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  const result = data?.result ?? null;

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col px-4 py-6 sm:px-6 lg:py-10">
      <header className="mb-6">
        <Link
          href="/"
          className="eyebrow mb-4 inline-flex rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          Back to app
        </Link>
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary/10 ring-1 ring-inset ring-primary/30">
            <FlaskConical className="h-4 w-4 text-primary" strokeWidth={1.6} aria-hidden />
          </span>
          <h1 className="font-display text-2xl font-bold tracking-tight">
            Rulebook Lab
          </h1>
          <span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Dev tool
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Run the decision pipeline on a description:{' '}
          <span className="text-foreground">retrieve → adjudicate</span>. Give a
          referee call to grade it, or leave it blank and the AI makes the call.
        </p>
      </header>

      {/* input panel */}
      <div className="bezel">
        <div className="bezel-core space-y-5 p-5">
          <SportSelector value={sport} onChange={setSport} />

          <div>
            <label htmlFor="lab-query" className="eyebrow mb-2.5 block">
              AI observation
            </label>
            <textarea
              id="lab-query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={3}
              placeholder="e.g. The defender slid in from behind and caught the attacker on the ankle before touching the ball."
              className="w-full resize-y rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
            {sport && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {EXAMPLES[sport].map((ex, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      setQuery(ex.obs);
                      setOriginalCall(ex.call);
                    }}
                    className="rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    Example {i + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <label htmlFor="lab-call" className="eyebrow mb-2.5 block">
              Referee’s call{' '}
              <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
                — leave blank and the AI makes the call itself
              </span>
            </label>
            <div className="relative">
              <Flag
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                strokeWidth={1.5}
                aria-hidden
              />
              <input
                id="lab-call"
                type="text"
                value={originalCall}
                onChange={(e) => setOriginalCall(e.target.value)}
                placeholder="e.g. Offside — goal disallowed  (or leave blank)"
                className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              />
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <label htmlFor="lab-k" className="eyebrow">
                Candidate rules to consider
              </label>
              <span className="font-display text-sm font-semibold tabular text-primary">
                {k}
              </span>
            </div>
            <input
              id="lab-k"
              type="range"
              min={1}
              max={10}
              step={1}
              value={k}
              onChange={(e) => setK(Number(e.target.value))}
              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-white/10 accent-[hsl(var(--primary))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
          </div>

          <Button onClick={run} disabled={!canRun} size="lg" className="w-full">
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Search className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
            )}
            {loading
              ? 'Deciding…'
              : originalCall.trim()
                ? 'Grade the call'
                : 'Make the call'}
          </Button>
        </div>
      </div>

      {/* results */}
      <div className="mt-6 flex-1 space-y-5" aria-live="polite">
        {error && (
          <p
            className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-card_red"
            role="alert"
          >
            {error}
          </p>
        )}

        {data && !error && (
          <>
            {result ? (
              <div className="bezel">
                <div className="bezel-core space-y-5 px-6 py-7">
                  <div className="flex flex-col items-center gap-5">
                    {result.mode === 'verdict' ? (
                      <>
                        <VerdictBadge verdict={result.verdict} />
                        <p className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground">
                          <Flag className="h-3 w-3" strokeWidth={1.5} aria-hidden />
                          Ref called:{' '}
                          <span className="font-medium text-foreground">
                            {result.originalCall}
                          </span>
                        </p>
                      </>
                    ) : (
                      <>
                        <RulingBadge
                          severity={result.severity}
                          decision={result.decision}
                        />
                        <p className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground">
                          No call on the field — the AI made the ruling
                        </p>
                      </>
                    )}
                    <div className="w-full max-w-xs">
                      <ConfidenceMeter confidence={result.confidence} />
                    </div>
                  </div>

                  <div className="space-y-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
                    <Section icon={Eye} title="What the AI saw">
                      {result.playDescription}
                    </Section>
                    <div className="h-px bg-white/[0.06]" />
                    <Section icon={Scale} title="Reasoning">
                      {result.reasoning}
                    </Section>
                  </div>

                  {result.rulesCited.length > 0 && (
                    <div>
                      <h3 className="eyebrow mb-2.5">
                        <Tag className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                        Rule{result.rulesCited.length > 1 ? 's' : ''} applied
                      </h3>
                      <ul className="space-y-3">
                        {result.rulesCited.map((rule) => (
                          <li
                            key={rule.code}
                            className="rounded-2xl border border-primary/25 bg-primary/[0.06] p-4"
                          >
                            <div className="flex flex-wrap items-baseline gap-2">
                              <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                                {rule.code}
                              </span>
                              <span className="font-display text-sm font-semibold">
                                {rule.title}
                              </span>
                            </div>
                            <RuleText text={rule.text} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <p className="eyebrow justify-center">
                    <span className="tabular">
                      {(result.processingMs / 1000).toFixed(1)}s
                    </span>{' '}
                    · {data.modelUsed ?? 'model'}
                  </p>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="h-4 w-4 text-card_yellow" strokeWidth={1.5} aria-hidden />
                  {data.adjudicationError
                    ? 'Adjudication failed'
                    : data.adjudicationAvailable
                      ? 'No decision returned'
                      : 'Adjudication step is off'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {data.adjudicationError
                    ? data.adjudicationError
                    : data.adjudicationAvailable
                      ? 'The retriever found no candidate rules to adjudicate.'
                      : 'Add OPENROUTER_API_KEY (or GEMINI_API_KEY) to .env and restart the dev server to enable decisions. Retrieval candidates are shown below.'}
                </p>
              </div>
            )}

            {/* RETRIEVAL CANDIDATES (collapsible) */}
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5">
              <Accordion type="single" collapsible defaultValue={result ? undefined : 'cands'}>
                <AccordionItem value="cands" className="border-b-0">
                  <AccordionTrigger className="hover:no-underline">
                    <span className="eyebrow">
                      <Search className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                      Retrieval candidates · {data.matches.length} of {data.totalRules} ({data.displayName})
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>
                    {data.matches.length === 0 ? (
                      <p className="pb-2 text-sm text-muted-foreground">
                        No rules matched. Try rephrasing closer to the rulebook’s
                        language.
                      </p>
                    ) : (
                      <ol className="space-y-3 pb-1">
                        {data.matches.map((rule, i) => (
                          <li
                            key={rule.code}
                            className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3.5"
                          >
                            <div className="flex items-start gap-3">
                              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/5 font-display text-[11px] font-bold text-muted-foreground">
                                {i + 1}
                              </span>
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-2">
                                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                                    {rule.code}
                                  </span>
                                  <span className="font-display text-sm font-semibold">
                                    {rule.title}
                                  </span>
                                </div>
                                <RuleText text={rule.text} />
                                {rule.keywords?.length > 0 && (
                                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                                    {rule.keywords.map((kw) => {
                                      const hit = Array.from(tokenize(kw)).some(
                                        (t) => queryTokens.has(t),
                                      );
                                      return (
                                        <span
                                          key={kw}
                                          className={
                                            hit
                                              ? 'rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary ring-1 ring-inset ring-primary/40'
                                              : 'rounded-full bg-white/[0.04] px-2 py-0.5 text-[10px] text-muted-foreground'
                                          }
                                        >
                                          {kw}
                                        </span>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

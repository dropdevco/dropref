'use client';

import {
  ExternalLink,
  Eye,
  Flag,
  RotateCcw,
  Scale,
  ScrollText,
  ShieldAlert,
  Users,
} from 'lucide-react';

import { ConfidenceMeter, CONFIDENCE_LABEL } from '@/components/confidence-meter';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { VerdictBadge, VERDICT_LABEL } from '@/components/verdict-badge';
import { cn } from '@/lib/utils';
import type { AnalyzeResponse, CitedRule } from '@/types/contract';

/**
 * Link out to the official rulebook passage a cited rule comes from. Renders
 * nothing when the payload carries no source, so legacy responses never show a
 * dangling link.
 */
/**
 * Only ever emit an http(s) `href`. The corpus is repo-controlled and validated
 * at load, but `lib/api-client.ts` does no runtime validation of the response
 * body — so a compromised or misbehaving backend is the one path that could put
 * a `javascript:` URL in front of a user. Cheap to close, so close it.
 */
function safeHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    // No base URL on purpose: rulebook sources are absolute by definition, and
    // omitting it keeps this safe to evaluate during server prerender, where
    // `window` does not exist. A relative value throws and is rejected.
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function RuleSourceLink({ rule }: { rule: CitedRule }) {
  const href = safeHttpUrl(rule.source?.url);
  if (!rule.source || !href) return null;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Read ${rule.code} on the official ${rule.source.publisher} rulebook (opens in a new tab)`}
      className="mt-2 inline-flex items-center gap-1.5 rounded text-xs font-medium text-primary underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden />
      <span>Read the official rule</span>
      <span className="font-normal text-muted-foreground">
        · {rule.source.label}
      </span>
    </a>
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
      <p className="text-[15px] leading-relaxed text-foreground/80">{children}</p>
    </div>
  );
}

export function ResultView({
  result,
  previewUrl,
  onReset,
}: {
  result: AnalyzeResponse;
  previewUrl: string | null;
  onReset: () => void;
}) {
  const videoSrc = result.annotatedVideoBase64
    ? `data:video/mp4;base64,${result.annotatedVideoBase64}`
    : previewUrl;

  // The graph's human gate fired: the system does NOT stand behind this verdict.
  // Showing it like any other result is the one thing the gate exists to stop.
  const held = result.needsHumanReview === true;
  const reasons = result.reviewReasons ?? [];
  const contested = result.contested ?? [];
  const panel = result.panel ?? [];
  const showDissent = contested.length > 0 || panel.length > 0;
  const reliabilityPct =
    typeof result.reliabilityScore === 'number'
      ? Math.round(result.reliabilityScore * 100)
      : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
      <p className="sr-only" role="status">
        {held
          ? `Held for human review. Provisional verdict, not confirmed: ${VERDICT_LABEL[result.verdict]}. `
          : `Verdict: ${VERDICT_LABEL[result.verdict]}. `}
        Confidence: {CONFIDENCE_LABEL[result.confidence]}.
      </p>

      {held && (
        <section
          aria-labelledby="held-title"
          className="rounded-2xl border border-card_yellow/40 bg-card_yellow/[0.07] p-5 lg:col-span-2 lg:p-6"
        >
          <h2
            id="held-title"
            className="flex items-center gap-2 font-display text-lg font-semibold text-card_yellow"
          >
            <ShieldAlert className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            Held for human review
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-foreground/80">
            We don&apos;t stand behind this verdict yet. Treat it as provisional
            and have a person check the play before relying on it.
          </p>
          {reasons.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-foreground/80">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        <div className="bezel">
          <div className="bezel-core flex flex-col items-center gap-5 px-6 py-8 lg:min-h-[520px] lg:justify-center">
            <div
              className={cn(
                'flex flex-col items-center gap-3',
                held && 'opacity-60 saturate-50',
              )}
            >
              <VerdictBadge verdict={result.verdict} />
            </div>
            {held && (
              <p className="rounded-full border border-card_yellow/40 bg-card_yellow/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-card_yellow">
                Provisional - not confirmed
              </p>
            )}
            {result.originalCall && (
              <p className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground">
                <Flag className="h-3 w-3" strokeWidth={1.5} aria-hidden />
                Ref called:{' '}
                <span className="font-medium text-foreground">
                  {result.originalCall}
                </span>
              </p>
            )}
            <div className="w-full max-w-xs">
              <ConfidenceMeter confidence={result.confidence} />
            </div>
            {reliabilityPct !== null && (
              <p className="eyebrow">
                Reliability <span className="tabular">{reliabilityPct}%</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col items-center gap-3">
          <Button onClick={onReset} size="lg" className="w-full">
            <RotateCcw className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
            Review another play
          </Button>
          <p className="eyebrow">
            <span className="tabular">
              {(result.processingMs / 1000).toFixed(1)}s
            </span>{' '}
            analyzed
          </p>
        </div>
      </aside>

      {videoSrc && (
        <div className="bezel overflow-hidden lg:col-start-2">
          <div className="flex items-center justify-center gap-1.5 border-b border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            <Eye className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            {result.annotatedVideoBase64
              ? 'Computer Vision Processed'
              : 'Original Video'}
          </div>
          <div className="bezel-core flex h-[min(62vh,34rem)] items-center overflow-hidden rounded-t-none bg-black/50 p-1.5">
            {/* User-supplied clip with native controls; no caption track is available for arbitrary uploads. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={videoSrc}
              className="h-full w-full rounded-xl object-contain"
              controls
              playsInline
              aria-label="Uploaded clip playback"
            />
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 lg:col-start-2 lg:p-6">
        <Section icon={Eye} title="What the AI saw">
          {result.playDescription}
        </Section>
        <div className="h-px bg-white/[0.06]" />
        <Section icon={Scale} title="Reasoning">
          {result.reasoning}
        </Section>
      </div>

      {showDissent && (
        <div className="space-y-4 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5 lg:col-start-2 lg:p-6">
          <h3 className="eyebrow">
            <Users className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
            Where the analysis disagreed
          </h3>
          {contested.length > 0 && (
            <div>
              <p className="text-sm text-foreground/70">
                The two observers could not agree on:
              </p>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[15px] text-foreground/80">
                {contested.map((fact) => (
                  <li key={fact}>{fact}</li>
                ))}
              </ul>
            </div>
          )}
          {panel.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {panel.map((seat, i) => (
                <li
                  key={`${seat.role}-${i}`}
                  className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-muted-foreground"
                >
                  <span className="font-medium text-foreground">{seat.role}</span>
                  {': '}
                  {VERDICT_LABEL[seat.verdict]} ({CONFIDENCE_LABEL[seat.confidence]})
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result.rulesCited.length > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 lg:col-start-2 lg:px-6">
          <Accordion type="single" collapsible>
            <AccordionItem value="rules" className="border-b-0">
              <AccordionTrigger className="hover:no-underline">
                <span className="eyebrow">
                  <ScrollText className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  Rulebook - {result.rulesCited.length} cited
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-4 pb-1">
                  {result.rulesCited.map((rule) => (
                    <li
                      key={rule.code}
                      className="border-l-2 border-primary/40 pl-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary">
                          {rule.code}
                        </span>
                        <span className="font-display text-sm font-semibold">
                          {rule.title}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-foreground/70">
                        {rule.text}
                      </p>
                      <RuleSourceLink rule={rule} />
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}
    </div>
  );
}

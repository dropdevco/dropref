'use client';

import { Eye, RotateCcw, Scale, ScrollText, Flag } from 'lucide-react';

import type { AnalyzeResponse } from '@/types/contract';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { VerdictBadge, VERDICT_LABEL } from '@/components/verdict-badge';
import { ConfidenceMeter, CONFIDENCE_LABEL } from '@/components/confidence-meter';

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

  return (
    <div className="space-y-5">
      <p className="sr-only" role="status">
        Verdict: {VERDICT_LABEL[result.verdict]}. Confidence:{' '}
        {CONFIDENCE_LABEL[result.confidence]}.
      </p>

      {/* verdict hero */}
      <div className="bezel">
        <div className="bezel-core flex flex-col items-center gap-5 px-6 py-8">
          <VerdictBadge verdict={result.verdict} />
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
        </div>
      </div>

      {videoSrc && (
        <div className="bezel overflow-hidden">
          <div className="bg-white/5 border-b border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center justify-center gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            {result.annotatedVideoBase64 ? 'Computer Vision Processed' : 'Original Video'}
          </div>
          <div className="bezel-core bg-black/50 p-1.5 rounded-t-none">
            {/* User-supplied clip with native controls — no caption track is
                available for arbitrary uploads. */}
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={videoSrc}
              className="mx-auto max-h-56 w-full rounded-xl object-contain rounded-t-none"
              controls
              playsInline
              aria-label="Uploaded clip playback"
            />
          </div>
        </div>
      )}

      <div className="space-y-5 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
        <Section icon={Eye} title="What the AI saw">
          {result.playDescription}
        </Section>
        <div className="h-px bg-white/[0.06]" />
        <Section icon={Scale} title="Reasoning">
          {result.reasoning}
        </Section>
      </div>

      {result.rulesCited.length > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5">
          <Accordion type="single" collapsible>
            <AccordionItem value="rules" className="border-b-0">
              <AccordionTrigger className="hover:no-underline">
                <span className="eyebrow">
                  <ScrollText className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
                  Rulebook · {result.rulesCited.length} cited
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
                    </li>
                  ))}
                </ul>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      )}

      <div className="flex flex-col items-center gap-3 pt-1">
        <Button onClick={onReset} size="lg" className="w-full">
          <RotateCcw className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
          Review another play
        </Button>
        <p className="eyebrow">
          <span className="tabular">
            {(result.processingMs / 1000).toFixed(1)}s
          </span>{' '}
          · analyzed
        </p>
      </div>
    </div>
  );
}

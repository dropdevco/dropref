'use client';

import { Eye, RotateCcw, Scale, ScrollText } from 'lucide-react';

import type { AnalyzeResponse } from '@/types/contract';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { VerdictBadge } from '@/components/verdict-badge';
import { ConfidenceMeter } from '@/components/confidence-meter';

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
      <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden />
        {title}
      </h3>
      <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
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
    <div className="space-y-6">
      {videoSrc && (
        <div className="overflow-hidden rounded-xl border bg-black">
          <div className="bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center justify-center gap-1.5">
            <Eye className="h-3.5 w-3.5" />
            {result.annotatedVideoBase64 ? 'Computer Vision Processed' : 'Original Video'}
          </div>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={videoSrc}
            className="mx-auto max-h-64 w-full object-contain"
            controls
            playsInline
          />
        </div>
      )}

      <div className="flex flex-col items-center gap-4 text-center">
        <VerdictBadge verdict={result.verdict} />
        {result.originalCall && (
          <p className="text-xs text-muted-foreground">
            Referee called:{' '}
            <span className="font-medium text-foreground">
              {result.originalCall}
            </span>
          </p>
        )}
      </div>

      <div className="mx-auto w-full max-w-xs">
        <ConfidenceMeter confidence={result.confidence} />
      </div>

      <div className="space-y-4 rounded-xl border bg-card p-4">
        <Section icon={Eye} title="What the AI saw">
          {result.playDescription}
        </Section>
        <div className="border-t" />
        <Section icon={Scale} title="Reasoning">
          {result.reasoning}
        </Section>
      </div>

      {result.rulesCited.length > 0 && (
        <div className="rounded-xl border bg-card px-4">
          <Accordion type="single" collapsible>
            <AccordionItem value="rules" className="border-b-0">
              <AccordionTrigger>
                <span className="flex items-center gap-1.5">
                  <ScrollText
                    className="h-4 w-4 text-muted-foreground"
                    aria-hidden
                  />
                  Rules cited ({result.rulesCited.length})
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-4">
                  {result.rulesCited.map((rule) => (
                    <li key={rule.code}>
                      <div className="flex items-baseline gap-2">
                        <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
                          {rule.code}
                        </span>
                        <span className="text-sm font-semibold">
                          {rule.title}
                        </span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
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

      <div className="flex flex-col items-center gap-3">
        <Button onClick={onReset} className="w-full" size="lg">
          <RotateCcw className="mr-2 h-4 w-4" aria-hidden />
          Analyze another
        </Button>
        <p className="text-[11px] text-muted-foreground">
          Analyzed in {(result.processingMs / 1000).toFixed(1)}s
        </p>
      </div>
    </div>
  );
}

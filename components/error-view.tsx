'use client';

import {
  AlertTriangle,
  Clock,
  FileVideo,
  Gauge,
  RotateCcw,
  ServerCrash,
  Weight,
  type LucideIcon,
} from 'lucide-react';

import type { AnalyzeError, ErrorCode } from '@/types/contract';
import { Button } from '@/components/ui/button';

const ERROR_COPY: Record<
  ErrorCode,
  { Icon: LucideIcon; title: string; body: string }
> = {
  FILE_TOO_LARGE: {
    Icon: Weight,
    title: 'That clip is too big',
    body: 'Clips need to be 20MB or smaller. Trim it down or export at a lower resolution and try again.',
  },
  BAD_FORMAT: {
    Icon: FileVideo,
    title: "That file isn't a video we can read",
    body: 'Use an MP4, MOV, or WebM clip. Screen recordings and phone camera exports usually work well.',
  },
  UNSUPPORTED_SPORT: {
    Icon: AlertTriangle,
    title: 'We don’t cover that sport yet',
    body: 'RefCheck currently supports soccer, football, and lacrosse. Pick one of those and try again.',
  },
  TIMEOUT: {
    Icon: Clock,
    title: 'The analysis timed out',
    body: 'The play took too long to process — often a sign of a longer or heavier clip. Try a shorter, tighter cut.',
  },
  RATE_LIMIT: {
    Icon: Gauge,
    title: 'Too many requests right now',
    body: 'We’re getting a lot of clips at once. Give it a moment, then run it again.',
  },
  MODEL_ERROR: {
    Icon: ServerCrash,
    title: 'The model hit a snag',
    body: 'Something went wrong while analyzing the play. This is usually temporary — try again in a few seconds.',
  },
};

export function ErrorView({
  error,
  onRetry,
}: {
  error: AnalyzeError;
  onRetry: () => void;
}) {
  const copy = ERROR_COPY[error.code] ?? ERROR_COPY.MODEL_ERROR;
  const { Icon, title, body } = copy;

  return (
    <div className="bezel" role="alert">
      <div className="bezel-core flex flex-col items-center gap-5 px-6 py-12 text-center">
        <div className="relative grid place-items-center">
          <span className="absolute h-16 w-16 rounded-full bg-destructive/20 blur-lg" />
          <div className="relative rounded-2xl border border-destructive/30 bg-destructive/10 p-3.5">
            <Icon className="h-7 w-7 text-card_red" strokeWidth={1.5} aria-hidden />
          </div>
        </div>
        <div className="space-y-1.5">
          <h2 className="font-display text-xl font-semibold">{title}</h2>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {body}
          </p>
        </div>
        {error.error && (
          <p className="max-w-sm rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-muted-foreground">
            <span className="text-card_red">{error.code}</span>: {error.error}
          </p>
        )}
        <Button onClick={onRetry} variant="outline">
          <RotateCcw className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
          Start over
        </Button>
      </div>
    </div>
  );
}

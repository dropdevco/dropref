'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Megaphone, Zap } from 'lucide-react';

import type {
  AnalyzeError,
  AnalyzeResponse,
  SportId,
} from '@/types/contract';
import { analyzeClip, isAnalyzeError } from '@/lib/api-client';
import {
  MAX_DURATION_S,
  checkFileMeta,
  readVideoDuration,
} from '@/components/clip';
import type { SportSample } from '@/components/sports';
import { Button } from '@/components/ui/button';
import { Whistle } from '@/components/whistle';
import { UploadZone } from '@/components/upload-zone';
import { SportSelector } from '@/components/sport-selector';
import { SampleClips } from '@/components/sample-clips';
import { AnalyzingState } from '@/components/analyzing-state';
import { ResultView } from '@/components/result-view';
import { ErrorView } from '@/components/error-view';

type Phase = 'idle' | 'analyzing' | 'result' | 'error';

function BrandMark() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-white/10 to-white/[0.02] ring-1 ring-inset ring-white/10">
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="#f8fafc" strokeWidth="1.6" />
          <path d="M7.5 12.4l3 3 6-6.4" fill="none" stroke="hsl(152 62% 46%)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="font-display text-lg font-bold tracking-tight">
        RefCheck<span className="text-primary"> AI</span>
      </span>
    </div>
  );
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sport, setSport] = useState<SportId | null>(null);
  const [originalCall, setOriginalCall] = useState('');
  const [rejection, setRejection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AnalyzeResponse | null>(null);
  const [error, setError] = useState<AnalyzeError | null>(null);

  // Move keyboard/screen-reader focus to the active view when the phase
  // changes, so a state swap doesn't strand focus on a button that's gone.
  const stageRef = useRef<HTMLElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    stageRef.current?.focus();
  }, [phase]);

  const previewRef = useRef<string | null>(null);
  const setPreview = useCallback((url: string | null) => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = url;
    setPreviewUrl(url);
  }, []);

  const acceptFile = useCallback(
    async (candidate: File) => {
      setRejection(null);
      const meta = checkFileMeta(candidate);
      if (!meta.ok) {
        setRejection(meta.reason);
        return;
      }

      setBusy(true);
      const url = URL.createObjectURL(candidate);
      try {
        const duration = await readVideoDuration(url);
        if (duration > MAX_DURATION_S) {
          URL.revokeObjectURL(url);
          setRejection(
            `Clip is ${duration.toFixed(1)}s. Keep it to ${MAX_DURATION_S}s or less.`,
          );
          return;
        }
        setFile(candidate);
        setPreview(url);
      } catch {
        URL.revokeObjectURL(url);
        setRejection('Could not read that video. Try a different file.');
      } finally {
        setBusy(false);
      }
    },
    [setPreview],
  );

  const loadSample = useCallback(
    async (sportId: SportId, sample: SportSample) => {
      setRejection(null);
      setBusy(true);
      try {
        const res = await fetch(sample.src);
        if (!res.ok) throw new Error('missing');
        const blob = await res.blob();
        const name = sample.src.split('/').pop() ?? 'sample.mp4';
        const asFile = new File([blob], name, {
          type: blob.type || 'video/mp4',
        });
        setSport(sportId);
        await acceptFile(asFile);
      } catch {
        setBusy(false);
        setRejection('That sample clip isn’t available yet.');
      }
    },
    [acceptFile],
  );

  const onAnalyze = useCallback(async () => {
    if (!file || !sport) return;
    setPhase('analyzing');
    const outcome = await analyzeClip({
      video: file,
      sport,
      originalCall: originalCall.trim() || null,
    });
    if (isAnalyzeError(outcome)) {
      setError(outcome);
      setPhase('error');
    } else {
      setResult(outcome);
      setPhase('result');
    }
  }, [file, sport, originalCall]);

  const reset = useCallback(() => {
    setPreview(null);
    setFile(null);
    setSport(null);
    setOriginalCall('');
    setRejection(null);
    setResult(null);
    setError(null);
    setPhase('idle');
  }, [setPreview]);

  const canAnalyze = Boolean(file && sport) && !busy;

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:py-8">
      <header className="mb-4 flex items-center justify-between">
        <BrandMark />
        <span className="eyebrow hidden sm:flex">
          <Zap className="h-3.5 w-3.5 text-primary" strokeWidth={1.5} aria-hidden />
          Instant replay, refereed by AI
        </span>
      </header>

      <section
        ref={stageRef}
        tabIndex={-1}
        className="flex flex-1 items-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div
          key={phase}
          className="w-full motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
        >
          {phase === 'idle' && (
            <div className="grid items-center gap-8 py-4 lg:grid-cols-2 lg:gap-14">
              {/* hero */}
              <div className="order-1 text-center lg:text-left">
                <span className="eyebrow justify-center lg:justify-start">
                  ⚽ Soccer · 🏈 Football · 🥍 Lacrosse
                </span>
                <h1 className="mt-4 font-display text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
                  Was it the{' '}
                  <span className="text-primary text-glow-green">right call?</span>
                </h1>
                <p className="mx-auto mt-4 max-w-md text-pretty text-base text-muted-foreground lg:mx-0">
                  Drop a clip, pick the sport. RefCheck watches the play and
                  rules on it — cited against the official rulebook, in seconds.
                </p>
                <div className="mt-8 hidden justify-center lg:flex lg:justify-start">
                  <Whistle className="w-52" />
                </div>
              </div>

              {/* interaction panel */}
              <div className="order-2 mx-auto w-full max-w-md lg:mx-0 lg:ml-auto">
                <div className="bezel">
                  <div className="bezel-core space-y-5 p-5">
                    {previewUrl ? (
                      <div className="space-y-2">
                        <div className="overflow-hidden rounded-xl border border-white/10 bg-black/50 p-1.5">
                          {/* User-supplied clip with native controls — no
                              caption track for arbitrary uploads. */}
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                          <video
                            src={previewUrl}
                            className="mx-auto max-h-56 w-full rounded-lg object-contain"
                            controls
                            playsInline
                            aria-label="Selected clip playback"
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPreview(null);
                            setFile(null);
                          }}
                          className="rounded text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                          Choose a different clip
                        </button>
                      </div>
                    ) : (
                      <UploadZone onPick={acceptFile} busy={busy} />
                    )}

                    {rejection && (
                      <p
                        className="flex items-start gap-1.5 text-sm text-card_red"
                        role="alert"
                      >
                        <AlertCircle
                          className="mt-0.5 h-4 w-4 shrink-0"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        {rejection}
                      </p>
                    )}

                    <SportSelector value={sport} onChange={setSport} />

                    <div>
                      <label
                        htmlFor="original-call"
                        className="eyebrow mb-2.5 block"
                      >
                        The call on the field{' '}
                        <span className="font-normal normal-case tracking-normal text-muted-foreground/70">
                          — optional
                        </span>
                      </label>
                      <div className="relative">
                        <Megaphone
                          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                        <input
                          id="original-call"
                          type="text"
                          value={originalCall}
                          onChange={(e) => setOriginalCall(e.target.value)}
                          placeholder="e.g. Offside — goal disallowed"
                          className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        />
                      </div>
                    </div>

                    <SampleClips onSelect={loadSample} disabled={busy} />

                    <Button
                      onClick={onAnalyze}
                      disabled={!canAnalyze}
                      size="lg"
                      className="w-full"
                    >
                      <Zap className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
                      Check the call
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {phase === 'analyzing' && previewUrl && (
            <div className="mx-auto max-w-xl">
              <AnalyzingState previewUrl={previewUrl} />
            </div>
          )}

          {phase === 'result' && result && (
            <div className="mx-auto max-w-xl">
              <ResultView result={result} previewUrl={previewUrl} onReset={reset} />
            </div>
          )}

          {phase === 'error' && error && (
            <div className="mx-auto max-w-xl">
              <ErrorView error={error} onRetry={reset} />
            </div>
          )}
        </div>
      </section>

      <footer className="mt-8 text-center text-[11px] text-muted-foreground/70">
        RefCheck AI · verdicts are informational, not official rulings.
      </footer>
    </main>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Sparkles } from 'lucide-react';

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
import { UploadZone } from '@/components/upload-zone';
import { SportSelector } from '@/components/sport-selector';
import { SampleClips } from '@/components/sample-clips';
import { AnalyzingState } from '@/components/analyzing-state';
import { ResultView } from '@/components/result-view';
import { ErrorView } from '@/components/error-view';

type Phase = 'idle' | 'analyzing' | 'result' | 'error';

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
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col px-4 py-6 sm:py-10">
      <header className="mb-6 text-center">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          AI instant replay
        </div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          RefCheck AI
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Was it the right call? Upload a clip and let the rulebook decide.
        </p>
      </header>

      <section
        ref={stageRef}
        tabIndex={-1}
        className="flex-1 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <div
          key={phase}
          className="motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
        >
        {phase === 'idle' && (
          <div className="space-y-6">
            {previewUrl ? (
              <div className="space-y-2">
                <div className="overflow-hidden rounded-xl border bg-black">
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <video
                    src={previewUrl}
                    className="mx-auto max-h-64 w-full object-contain"
                    controls
                    playsInline
                  />
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPreview(null);
                    setFile(null);
                  }}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Choose a different clip
                </button>
              </div>
            ) : (
              <UploadZone onPick={acceptFile} busy={busy} />
            )}

            {rejection && (
              <p
                className="flex items-start gap-1.5 text-sm text-destructive"
                role="alert"
              >
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {rejection}
              </p>
            )}

            <SportSelector value={sport} onChange={setSport} />

            <div>
              <label
                htmlFor="original-call"
                className="mb-2 block text-sm font-medium"
              >
                What was the call on the field?{' '}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <input
                id="original-call"
                type="text"
                value={originalCall}
                onChange={(e) => setOriginalCall(e.target.value)}
                placeholder="e.g. Offside — goal disallowed"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <SampleClips onSelect={loadSample} disabled={busy} />

            <Button
              onClick={onAnalyze}
              disabled={!canAnalyze}
              size="lg"
              className="w-full"
            >
              Analyze the call
            </Button>
          </div>
        )}

        {phase === 'analyzing' && previewUrl && (
          <AnalyzingState previewUrl={previewUrl} />
        )}

        {phase === 'result' && result && (
          <ResultView result={result} previewUrl={previewUrl} onReset={reset} />
        )}

        {phase === 'error' && error && (
          <ErrorView error={error} onRetry={reset} />
        )}
        </div>
      </section>

      <footer className="mt-8 text-center text-[11px] text-muted-foreground">
        RefCheck AI · verdicts are informational, not official rulings.
      </footer>
    </main>
  );
}

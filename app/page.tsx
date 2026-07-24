'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Megaphone,
  Zap,
} from 'lucide-react';

import type {
  AnalyzeError,
  AnalyzeResponse,
  SportId,
} from '@/types/contract';
import {
  analyzeClip,
  isAnalyzeError,
} from '@/lib/api-client';
import {
  DEFAULT_VIDEO_CROP,
  cropVideoFile,
  type VideoCrop,
} from '@/lib/video-crop';
import {
  DURATION_METADATA_TOLERANCE_S,
  MAX_DURATION_S,
  checkFileMeta,
  readVideoDuration,
} from '@/components/clip';
import { Button } from '@/components/ui/button';
import { Whistle } from '@/components/whistle';
import { UploadZone } from '@/components/upload-zone';
import { SportSelector } from '@/components/sport-selector';
import { VideoCropper } from '@/components/video-cropper';
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
  const [preparedFile, setPreparedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [submittedPreviewUrl, setSubmittedPreviewUrl] = useState<string | null>(
    null,
  );
  const [crop, setCrop] = useState<VideoCrop>(DEFAULT_VIDEO_CROP);
  const [sport, setSport] = useState<SportId | null>(null);
  const [originalCall, setOriginalCall] = useState('');
  const [rejection, setRejection] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingVideo, setSettingVideo] = useState(false);
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

  const submittedPreviewRef = useRef<string | null>(null);
  const setSubmittedPreview = useCallback((url: string | null) => {
    if (submittedPreviewRef.current) {
      URL.revokeObjectURL(submittedPreviewRef.current);
    }
    submittedPreviewRef.current = url;
    setSubmittedPreviewUrl(url);
  }, []);

  const clearPreparedVideo = useCallback(() => {
    setPreparedFile(null);
    setSubmittedPreview(null);
  }, [setSubmittedPreview]);

  const updateCrop = useCallback(
    (nextCrop: VideoCrop) => {
      setCrop(nextCrop);
      clearPreparedVideo();
    },
    [clearPreparedVideo],
  );

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
        if (duration > MAX_DURATION_S + DURATION_METADATA_TOLERANCE_S) {
          URL.revokeObjectURL(url);
          setRejection(
            `Clip is ${duration.toFixed(2)}s. Keep it to ${MAX_DURATION_S}s or less.`,
          );
          return;
        }
        setFile(candidate);
        setPreparedFile(null);
        setCrop(DEFAULT_VIDEO_CROP);
        setPreview(url);
        setSubmittedPreview(null);
      } catch {
        URL.revokeObjectURL(url);
        setRejection('Could not read that video. Try a different file.');
      } finally {
        setBusy(false);
      }
    },
    [setPreview, setSubmittedPreview],
  );

  const prepareVideo = useCallback(async () => {
    if (!file) return;

    setSettingVideo(true);
    setRejection(null);
    clearPreparedVideo();

    try {
      const videoForAnalysis = await cropVideoFile(file, crop);
      setPreparedFile(videoForAnalysis);
      setSubmittedPreview(URL.createObjectURL(videoForAnalysis));
    } catch {
      setRejection('Could not set that video. Try a different edit.');
    } finally {
      setSettingVideo(false);
    }
  }, [clearPreparedVideo, crop, file, setSubmittedPreview]);

  const onAnalyze = useCallback(async () => {
    if (!preparedFile || !sport) {
      setRejection('Set the edited video before checking the call.');
      return;
    }
    setBusy(true);
    setRejection(null);
    setPhase('analyzing');

    const outcome = await analyzeClip({
      video: preparedFile,
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
    setBusy(false);
  }, [originalCall, preparedFile, sport]);

  const reset = useCallback(() => {
    setPreview(null);
    setSubmittedPreview(null);
    setFile(null);
    setPreparedFile(null);
    setCrop(DEFAULT_VIDEO_CROP);
    setSport(null);
    setOriginalCall('');
    setRejection(null);
    setResult(null);
    setError(null);
    setPhase('idle');
  }, [setPreview, setSubmittedPreview]);

  const canAnalyze = Boolean(preparedFile && sport) && !busy && !settingVideo;
  const canSetVideo = Boolean(file) && !busy && !settingVideo;

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-[1500px] flex-col px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
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
            <>
              <div className="hidden gap-7 py-3 lg:grid lg:grid-cols-[minmax(0,1.35fr)_minmax(390px,460px)] lg:items-start">
                <div className="space-y-5">
                  <div className="max-w-3xl">
                    <span className="eyebrow">Soccer · Football · Lacrosse</span>
                    <h1 className="mt-3 font-display text-6xl font-bold leading-[1.02] tracking-tight xl:text-7xl">
                      Was it the{' '}
                      <span className="text-primary text-glow-green">right call?</span>
                    </h1>
                    <p className="mt-4 max-w-2xl text-pretty text-lg leading-8 text-muted-foreground">
                      Drop a clip, pick the sport. RefCheck watches the play and
                      rules on it, cited against the official rulebook.
                    </p>
                  </div>

                  <div className="bezel">
                    <div className="bezel-core flex min-h-[560px] flex-col overflow-hidden">
                      <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-3">
                        <span className="eyebrow">Replay desk</span>
                        <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[11px] font-medium text-primary">
                          Ready for review
                        </span>
                      </div>

                      <div className="flex flex-1 flex-col p-5">
                        {previewUrl ? (
                          <div className="flex h-full flex-col gap-3">
                            <div className="min-h-[420px] flex-1">
                              <VideoCropper
                                src={previewUrl}
                                crop={crop}
                                onCropChange={updateCrop}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setPreview(null);
                                setSubmittedPreview(null);
                                setFile(null);
                                setPreparedFile(null);
                                setCrop(DEFAULT_VIDEO_CROP);
                              }}
                              className="self-start rounded text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                            >
                              Choose a different clip
                            </button>
                          </div>
                        ) : (
                          <UploadZone
                            onPick={acceptFile}
                            busy={busy}
                            className="min-h-[480px] flex-1"
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                <aside className="sticky top-6 space-y-4">
                  <div className="flex items-center justify-between rounded-2xl border border-white/[0.06] bg-white/[0.02] px-5 py-4">
                    <div>
                      <span className="eyebrow">Review controls</span>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Select context, then run the call.
                      </p>
                    </div>
                    <Whistle className="w-24" />
                  </div>

                  {rejection && (
                    <p
                      className="flex items-start gap-1.5 rounded-xl border border-card_red/25 bg-card_red/10 px-3 py-2 text-sm text-card_red"
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

                  <div className="bezel">
                    <div className="bezel-core p-4">
                      <SportSelector value={sport} onChange={setSport} />
                    </div>
                  </div>

                  <div className="bezel">
                    <div className="bezel-core p-4">
                      <label
                        htmlFor="original-call-desktop"
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
                          id="original-call-desktop"
                          type="text"
                          value={originalCall}
                          onChange={(e) => setOriginalCall(e.target.value)}
                          placeholder="e.g. Offside — goal disallowed"
                          className="w-full rounded-xl border border-white/10 bg-white/[0.03] py-2.5 pl-9 pr-3 text-sm placeholder:text-muted-foreground/60 focus-visible:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        />
                      </div>
                    </div>
                  </div>

                  {previewUrl && (
                    <Button
                      type="button"
                      onClick={prepareVideo}
                      disabled={!canSetVideo}
                      variant={preparedFile ? 'outline' : 'default'}
                      size="lg"
                      className="h-12 w-full text-base"
                    >
                      <Check className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
                      {settingVideo
                        ? 'Setting video...'
                        : preparedFile
                          ? 'Video set'
                          : 'Set this video'}
                    </Button>
                  )}

                  <Button
                    onClick={onAnalyze}
                    disabled={!canAnalyze}
                    size="lg"
                    className="h-12 w-full text-base"
                  >
                    <Zap className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
                    Check the call
                  </Button>
                </aside>
              </div>

              <div className="grid items-center gap-8 py-4 lg:hidden">
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
                        <div>
                          <VideoCropper
                            src={previewUrl}
                            crop={crop}
                            onCropChange={updateCrop}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setPreview(null);
                            setSubmittedPreview(null);
                            setFile(null);
                            setPreparedFile(null);
                            setCrop(DEFAULT_VIDEO_CROP);
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

                    {previewUrl && (
                      <Button
                        type="button"
                        onClick={prepareVideo}
                        disabled={!canSetVideo}
                        variant={preparedFile ? 'outline' : 'default'}
                        size="lg"
                        className="w-full"
                      >
                        <Check className="mr-2 h-4 w-4" strokeWidth={2} aria-hidden />
                        {settingVideo
                          ? 'Setting video...'
                          : preparedFile
                            ? 'Video set'
                            : 'Set this video'}
                      </Button>
                    )}

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
            </>
          )}

          {phase === 'analyzing' && (
            <div className="mx-auto w-full max-w-5xl">
              <AnalyzingState previewUrl={submittedPreviewUrl ?? previewUrl} />
            </div>
          )}

          {phase === 'result' && result && (
            <div className="mx-auto w-full max-w-6xl">
              <ResultView
                result={result}
                previewUrl={submittedPreviewUrl ?? previewUrl}
                onReset={reset}
              />
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

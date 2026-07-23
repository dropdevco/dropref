'use client';

import { useRef, useState } from 'react';
import { Clapperboard, UploadCloud } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ACCEPT_ATTR } from '@/components/clip';

export function UploadZone({
  onPick,
  busy,
}: {
  onPick: (file: File) => void;
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) onPick(file);
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      aria-label="Upload a clip. Drop a video file here or activate to browse. MP4, MOV or WebM, up to 20MB, 15 seconds or shorter."
      aria-disabled={busy || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      className={cn(
        'group relative flex cursor-pointer flex-col items-center justify-center gap-4 overflow-hidden rounded-[calc(var(--radius)+0.25rem)] px-6 py-12 text-center transition-all duration-300 ease-smooth',
        'border border-dashed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        dragging
          ? 'scale-[1.01] border-primary bg-primary/[0.07] shadow-[0_0_40px_hsl(var(--primary)/0.18)]'
          : 'border-white/15 bg-white/[0.02] hover:border-primary/50 hover:bg-white/[0.035]',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      {/* corner pitch-marks */}
      <span className="pointer-events-none absolute left-3 top-3 h-4 w-4 rounded-tl-md border-l-2 border-t-2 border-white/15" />
      <span className="pointer-events-none absolute right-3 top-3 h-4 w-4 rounded-tr-md border-r-2 border-t-2 border-white/15" />
      <span className="pointer-events-none absolute bottom-3 left-3 h-4 w-4 rounded-bl-md border-b-2 border-l-2 border-white/15" />
      <span className="pointer-events-none absolute bottom-3 right-3 h-4 w-4 rounded-br-md border-b-2 border-r-2 border-white/15" />

      <div className="relative grid place-items-center">
        <span
          className={cn(
            'absolute h-14 w-14 rounded-full bg-primary/20 blur-md transition-opacity',
            dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        />
        <div className="relative rounded-2xl border border-white/10 bg-gradient-to-b from-white/10 to-white/[0.02] p-3.5">
          <UploadCloud
            className="h-6 w-6 text-primary"
            strokeWidth={1.5}
            aria-hidden
          />
        </div>
      </div>
      <div>
        <p className="font-display text-base font-semibold">
          Drop your clip, or{' '}
          <span className="text-primary underline decoration-primary/40 underline-offset-4">
            browse
          </span>
        </p>
        <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clapperboard className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
          MP4, MOV or WebM · ≤20MB · ≤15s
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        aria-label="Choose a video clip to upload"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

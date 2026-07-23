'use client';

import { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';

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
        'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        dragging
          ? 'border-primary bg-primary/5'
          : 'border-input hover:border-primary/60 hover:bg-accent/40',
        busy && 'pointer-events-none opacity-60',
      )}
    >
      <div className="rounded-full bg-muted p-3">
        <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-medium">
          Drop a clip here, or <span className="text-primary">browse</span>
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          MP4, MOV or WebM · up to 20MB · 15s or shorter
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

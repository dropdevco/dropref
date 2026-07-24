'use client';

import { useState } from 'react';
import { Upload, Loader2, AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function CVTestSandbox() {
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [skeletonSrc, setSkeletonSrc] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<File | null>(null);

  const processVideo = async (file: File) => {
    setIsProcessing(true);
    setError(null);
    setVideoSrc(null);
    setSkeletonSrc(null);

    const formData = new FormData();
    formData.append('video', file);

    try {
      const response = await fetch('/api/cv-test', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to process video');
      }

      const data = await response.json();
      
      if (data.videoBase64) {
        setVideoSrc(`data:${data.mimeType};base64,${data.videoBase64}`);
      } else {
        throw new Error('No video data returned from CV service');
      }

      if (data.skeletonBase64) {
        setSkeletonSrc(`data:${data.mimeType};base64,${data.skeletonBase64}`);
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An unexpected error occurred');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCurrentFile(file);
    await processVideo(file);
  };

  return (
    <div className="min-h-screen bg-black text-white p-8 font-sans">
      <div className="max-w-4xl mx-auto space-y-8">
        
        <div>
          <h1 className="text-3xl font-bold tracking-tight mb-2 text-primary">Computer Vision Sandbox</h1>
          <p className="text-muted-foreground">
            Upload a video to instantly test the OpenCV Action Cropping algorithm. This bypasses the Gemini LLM entirely.
          </p>
        </div>

        <div className="bezel p-8 flex flex-col items-center justify-center border-2 border-dashed border-white/20 rounded-xl bg-white/5 hover:bg-white/10 transition-colors">
          <input
            type="file"
            accept="video/mp4,video/quicktime,video/x-m4v,video/*"
            onChange={handleFileUpload}
            className="hidden"
            id="video-upload"
            disabled={isProcessing}
          />
          <label
            htmlFor="video-upload"
            className="flex flex-col items-center justify-center cursor-pointer space-y-4 w-full h-48"
          >
            {isProcessing ? (
              <Loader2 className="w-12 h-12 animate-spin text-primary" />
            ) : (
              <Upload className="w-12 h-12 text-muted-foreground" />
            )}
            <span className="text-lg font-medium">
              {isProcessing ? 'Processing in OpenCV...' : 'Click to Upload Video'}
            </span>
          </label>
        </div>

        {error && (
          <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {videoSrc && (
          <div className="space-y-4 w-full">
            <h2 className="text-xl font-semibold">Processed Output</h2>
            
            <div className={`grid gap-6 ${skeletonSrc ? 'grid-cols-2' : 'grid-cols-1'}`}>
              
              <div className="bezel overflow-hidden">
                <div className="bg-white/5 border-b border-white/10 px-4 py-2 text-xs font-medium text-muted-foreground">
                  Original + Annotations
                </div>
                <div className="bezel-core bg-black p-2 rounded-t-none">
                  <video
                    src={videoSrc}
                    className="w-full rounded-lg"
                    controls
                    autoPlay
                    loop
                    playsInline
                  />
                </div>
              </div>

              {skeletonSrc && (
                <div className="bezel overflow-hidden">
                  <div className="bg-white/5 border-b border-white/10 px-4 py-2 text-xs font-medium text-muted-foreground">
                    Synthetic Smooth Render (Virtual Pitch)
                  </div>
                  <div className="bezel-core bg-black p-2 rounded-t-none">
                    <video
                      src={skeletonSrc}
                      className="w-full rounded-lg"
                      controls
                      autoPlay
                      loop
                      playsInline
                    />
                  </div>
                </div>
              )}

            </div>

            {currentFile && (
              <div className="flex justify-end mt-4">
                 <Button onClick={() => processVideo(currentFile)} disabled={isProcessing} variant="secondary" className="gap-2">
                    <RefreshCw className="w-4 h-4" />
                    Retry {currentFile.name}
                 </Button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

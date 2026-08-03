'use client';

import { useState, useRef, MouseEvent, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, AlertCircle, Crosshair, X, Scan, Video as VideoIcon } from "lucide-react";

type SamObject = {
  id: number;
  points: { x: number; y: number }[];
  maskUrl: string;
  color: { r: number; g: number; b: number; hex: string };
};

const COLORS = [
  { r: 255, g: 0, b: 0, hex: "#ff0000" }, // Red
  { r: 0, g: 255, b: 0, hex: "#00ff00" }, // Green
  { r: 0, g: 128, b: 255, hex: "#0080ff" }, // Blue
  { r: 255, g: 255, b: 0, hex: "#ffff00" }, // Yellow
  { r: 255, g: 0, b: 255, hex: "#ff00ff" }, // Magenta
];

export function AdvancedLayer({
  videoFile,
  crop,
  trim,
  onComplete,
  onCancel,
}: {
  videoFile: File;
  crop: { x: number; y: number; width: number; height: number };
  trim: [number, number];
  onComplete: (skeletonFile: File) => void;
  onCancel: () => void;
}) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  
  const [objects, setObjects] = useState<SamObject[]>([]);
  const [activeObjectId, setActiveObjectId] = useState<number>(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isFrameLocked, setIsFrameLocked] = useState(false);
  
  const [generatedSkeleton, setGeneratedSkeleton] = useState<File | null>(null);
  const [generatedSkeletonUrl, setGeneratedSkeletonUrl] = useState<string | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [videoFile]);

  const captureFrame = async (): Promise<Blob | null> => {
    if (!videoRef.current) return null;
    const video = videoRef.current;
    
    const targetW = crop.width * video.videoWidth;
    const targetH = crop.height * video.videoHeight;
    
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    
    ctx.drawImage(
      video, 
      crop.x * video.videoWidth, 
      crop.y * video.videoHeight, 
      targetW, 
      targetH, 
      0, 0, targetW, targetH
    );
    
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.95);
    });
  };

  const lockFrame = async () => {
    if (!videoRef.current) return;
    setIsPreviewing(true);
    setError(null);
    try {
      const frameBlob = await captureFrame();
      if (!frameBlob) throw new Error("Could not capture frame");
      const formData = new FormData();
      formData.append("image", frameBlob, "frame.jpg");
      
      const res = await fetch("http://127.0.0.1:8000/set-image", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      setIsFrameLocked(true);
    } catch (err: any) {
      setError(err.message || "Failed to lock frame");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleVideoClick = async (e: MouseEvent<HTMLVideoElement>) => {
    if (!videoRef.current || isPreviewing || !isFrameLocked) return;
    
    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const scaleX = videoRef.current.videoWidth / rect.width;
    const scaleY = videoRef.current.videoHeight / rect.height;
    
    let intrinsicX = x * scaleX;
    let intrinsicY = y * scaleY;
    
    const cropPixelX = crop.x * videoRef.current.videoWidth;
    const cropPixelY = crop.y * videoRef.current.videoHeight;
    const cropPixelW = crop.width * videoRef.current.videoWidth;
    const cropPixelH = crop.height * videoRef.current.videoHeight;
    
    if (intrinsicX < cropPixelX || intrinsicY < cropPixelY || intrinsicX > cropPixelX + cropPixelW || intrinsicY > cropPixelY + cropPixelH) {
      return; // Ignored click outside crop box
    }
    
    // Adjust coordinates so they are relative to the CROPPED frame
    intrinsicX -= cropPixelX;
    intrinsicY -= cropPixelY;
    
    const targetObjIdx = objects.findIndex(o => o.id === activeObjectId);
    const isNewObject = targetObjIdx === -1;
    
    if (isNewObject && objects.length >= 5) {
      setError("Maximum 5 objects allowed");
      return;
    }
    
    setIsPreviewing(true);
    setError(null);
    
    try {
      const color = isNewObject ? COLORS[objects.length] : objects[targetObjIdx].color;
      const currentPoints = isNewObject ? [] : objects[targetObjIdx].points;
      const newPoints = [...currentPoints, { x: intrinsicX, y: intrinsicY }];
      
      const formData = new FormData();
      formData.append("points", JSON.stringify(newPoints.map(p => [p.x, p.y])));
      formData.append("r", color.r.toString());
      formData.append("g", color.g.toString());
      formData.append("b", color.b.toString());
      
      const res = await fetch("http://127.0.0.1:8000/preview-mask", {
        method: "POST",
        body: formData,
      });
      
      if (!res.ok) throw new Error(await res.text());
      
      const maskBlob = await res.blob();
      const maskUrl = URL.createObjectURL(maskBlob);
      
      if (isNewObject) {
        setObjects([...objects, {
          id: activeObjectId,
          points: newPoints,
          maskUrl,
          color
        }]);
      } else {
        const newObjects = [...objects];
        newObjects[targetObjIdx] = {
          ...newObjects[targetObjIdx],
          points: newPoints,
          maskUrl
        };
        setObjects(newObjects);
      }
      
    } catch (err: any) {
      setError(err.message || "Failed to preview mask");
    } finally {
      setIsPreviewing(false);
    }
  };

  const removeObject = (id: number) => {
    const remaining = objects.filter(o => o.id !== id);
    setObjects(remaining);
    if (activeObjectId === id) {
      setActiveObjectId(remaining.length > 0 ? remaining[0].id : 1);
    }
  };

  const processVideo = async () => {
    if (objects.length === 0) {
      setError("Please add at least one object mask.");
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    
    try {
      const promptsPayload = objects.map((obj) => ({
        object_id: obj.id,
        frame_idx: 0,
        points: obj.points.map(p => [p.x, p.y]),
        labels: obj.points.map(() => 1)
      }));

      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("prompts", JSON.stringify(promptsPayload));
      formData.append("start_sec", trim[0].toString());
      
      const endTime = trim[1] > 0 ? trim[1] : videoRef.current!.duration;
      formData.append("end_sec", endTime.toString());
      
      const cropPixelX = crop.x * videoRef.current!.videoWidth;
      const cropPixelY = crop.y * videoRef.current!.videoHeight;
      const cropPixelW = crop.width * videoRef.current!.videoWidth;
      const cropPixelH = crop.height * videoRef.current!.videoHeight;

      formData.append("crop_x", cropPixelX.toString());
      formData.append("crop_y", cropPixelY.toString());
      formData.append("crop_w", cropPixelW.toString());
      formData.append("crop_h", cropPixelH.toString());

      const res = await fetch("http://127.0.0.1:8000/process-video", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await res.text() || "Failed to process video");
      }

      const blob = await res.blob();
      const skeletonFile = new File([blob], "skeleton.mp4", { type: "video/mp4" });
      setGeneratedSkeleton(skeletonFile);
      setGeneratedSkeletonUrl(URL.createObjectURL(skeletonFile));
      setIsProcessing(false);
      
    } catch (err: any) {
      setError(err.message);
      setIsProcessing(false);
    }
  };

  if (generatedSkeleton && generatedSkeletonUrl) {
    return (
      <div className="flex h-full min-h-[480px] flex-col gap-3 relative animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-xl font-medium tracking-tight">Review Tracking Mask</h2>
          <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted-foreground hover:text-white">
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-black flex items-center justify-center">
          <video
            src={generatedSkeletonUrl}
            className="max-h-full max-w-full object-contain"
            controls
            autoPlay
            loop
          />
        </div>
        <div className="flex gap-2">
          <Button 
            variant="outline" 
            className="flex-1"
            onClick={() => {
              setGeneratedSkeleton(null);
              setGeneratedSkeletonUrl(null);
            }}
          >
            Discard & Retry
          </Button>
          <Button 
            className="flex-1 bg-white text-black hover:bg-white/90"
            onClick={() => onComplete(generatedSkeleton)}
          >
            Save Tracking Mask
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-3 relative animate-in fade-in zoom-in-95 duration-200">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-medium tracking-tight">Advanced Object Selector</h2>
        <Button variant="ghost" size="sm" onClick={onCancel} className="text-muted-foreground hover:text-white">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {error && (
        <div className="rounded-xl border border-card_red/25 bg-card_red/10 px-3 py-2 text-sm text-card_red flex items-center">
          <AlertCircle className="mr-2 h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="relative flex-1 overflow-hidden rounded-xl border border-white/10 bg-black flex items-center justify-center p-4">
        {videoUrl && (
          <div className={`relative inline-block overflow-hidden shadow-lg ${!isFrameLocked && 'opacity-50 pointer-events-none'}`}>
            <video
              ref={videoRef}
              src={videoUrl}
              className={`max-w-full h-auto ${isPreviewing ? 'cursor-wait' : (isFrameLocked ? 'cursor-crosshair' : '')}`}
              onClick={handleVideoClick}
              onLoadedMetadata={(e) => {
                e.currentTarget.currentTime = trim[0]; // Lock to first frame initially
              }}
              onSeeked={(e) => {
                if (!isFrameLocked && !isPreviewing && e.currentTarget.currentTime === trim[0]) {
                  lockFrame();
                }
              }}
            />
            
            {/* Crop Overlay */}
            <div 
              className="absolute border-2 border-dashed border-green-500 bg-green-500/10 pointer-events-none"
              style={{
                left: `${crop.x * 100}%`,
                top: `${crop.y * 100}%`,
                width: `${crop.width * 100}%`,
                height: `${crop.height * 100}%`
              }}
            />
            
            {/* Draw Masks Overlay */}
            {objects.map(obj => (
              <img 
                key={obj.id} 
                src={obj.maskUrl} 
                alt="mask" 
                className="absolute pointer-events-none opacity-50 mix-blend-screen"
                style={{
                  left: `${crop.x * 100}%`,
                  top: `${crop.y * 100}%`,
                  width: `${crop.width * 100}%`,
                  height: `${crop.height * 100}%`
                }}
              />
            ))}
            
            {/* Draw Point Markers */}
            {videoRef.current && objects.map(obj => 
              obj.points.map((p, i) => {
                const cropPixelX = crop.x * videoRef.current!.videoWidth;
                const cropPixelY = crop.y * videoRef.current!.videoHeight;
                
                const cssLeft = ((p.x + cropPixelX) / videoRef.current!.videoWidth) * 100;
                const cssTop = ((p.y + cropPixelY) / videoRef.current!.videoHeight) * 100;
                
                return (
                  <div 
                    key={`${obj.id}-${i}`}
                    className="absolute w-2 h-2 rounded-full -translate-x-1/2 -translate-y-1/2 pointer-events-none ring-2 ring-white"
                    style={{ left: `${cssLeft}%`, top: `${cssTop}%`, backgroundColor: obj.color.hex }}
                  />
                );
              })
            )}

            {isPreviewing && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="w-8 h-8 animate-spin text-white" />
              </div>
            )}
          </div>
        )}
      </div>
      
      <div className="flex flex-col gap-3">
        <div className="p-4 rounded-xl border border-white/10 bg-white/5 space-y-3 relative overflow-hidden">
          {!isFrameLocked && (
            <div className="absolute inset-0 bg-black/60 z-10 flex flex-col items-center justify-center backdrop-blur-sm">
              <Loader2 className="h-6 w-6 animate-spin text-white mb-2" />
              <p className="text-sm font-medium">Preparing first frame...</p>
            </div>
          )}
          
          <div className="flex items-center justify-between">
            <p className="text-sm text-white font-medium flex items-center">
              <Crosshair className="mr-2 h-4 w-4 text-primary" />
              Select Objects
            </p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Click inside the green crop box to select objects. Add points to refine the mask. Add a new object to track multiple subjects.
          </p>
            
            <div className="flex flex-wrap gap-2">
              {objects.map(obj => (
                <div key={obj.id} className={`flex items-center pl-2 pr-1 py-1 rounded-md text-xs font-medium border cursor-pointer ${activeObjectId === obj.id ? 'bg-white/10 border-white/20' : 'bg-transparent border-transparent text-muted-foreground hover:bg-white/5'}`} onClick={() => setActiveObjectId(obj.id)}>
                  <div className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: obj.color.hex }} />
                  Object {obj.id}
                  <button onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }} className="ml-2 hover:text-white p-0.5 rounded">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
              
              {objects.length < 5 && (
                <Button 
                  size="sm" 
                  variant="outline" 
                  className="h-7 text-xs border-dashed text-muted-foreground hover:text-white"
                  onClick={() => {
                    const nextId = Math.max(0, ...objects.map(o => o.id)) + 1;
                    setActiveObjectId(nextId);
                  }}
                >
                  + Add Object
                </Button>
              )}
            </div>

            <Button 
              onClick={processVideo} 
              disabled={isProcessing || objects.length === 0} 
              className="w-full mt-2 bg-white text-black hover:bg-white/90"
            >
              {isProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <VideoIcon className="mr-2 h-4 w-4" />}
              {isProcessing ? "Generating Tracking Mask..." : "Generate Tracking Mask"}
            </Button>
          </div>
      </div>
    </div>
  );
}

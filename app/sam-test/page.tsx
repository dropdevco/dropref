"use client";

import { useState, useRef, MouseEvent, PointerEvent, useEffect } from "react";
import { analyzeClip, isAnalyzeError } from "@/lib/api-client";
import type { AnalyzeResponse, AnalyzeError } from "@/types/contract";

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

export default function SamTestPage() {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [rawVideoUrl, setRawVideoUrl] = useState<string | null>(null);
  const [resultVideoUrl, setResultVideoUrl] = useState<string | null>(null);
  const [yoloVideoUrl, setYoloVideoUrl] = useState<string | null>(null);
  
  const [objects, setObjects] = useState<SamObject[]>([]);
  const [activeObjectId, setActiveObjectId] = useState<number>(1);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isProcessingRaw, setIsProcessingRaw] = useState(false);
  const [isProcessingYolo, setIsProcessingYolo] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isFrameLocked, setIsFrameLocked] = useState(false);
  
  const [analysisRaw, setAnalysisRaw] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [analysisSam, setAnalysisSam] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [analysisYolo, setAnalysisYolo] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [analysisStacked, setAnalysisStacked] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [analysisStackedSam, setAnalysisStackedSam] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [analysisStackedRawSam, setAnalysisStackedRawSam] = useState<AnalyzeResponse | AnalyzeError | null>(null);
  const [isAnalyzingRaw, setIsAnalyzingRaw] = useState(false);
  const [isAnalyzingSam, setIsAnalyzingSam] = useState(false);
  const [isAnalyzingYolo, setIsAnalyzingYolo] = useState(false);
  const [isAnalyzingStacked, setIsAnalyzingStacked] = useState(false);
  const [isAnalyzingStackedSam, setIsAnalyzingStackedSam] = useState(false);
  const [isAnalyzingStackedRawSam, setIsAnalyzingStackedRawSam] = useState(false);
  const [extractedNumbers, setExtractedNumbers] = useState<string[] | null>(null);
  const [extractedObjectsCount, setExtractedObjectsCount] = useState<number | null>(null);
  const [isExtractingNumbers, setIsExtractingNumbers] = useState(false);
  
  const [cropRect, setCropRect] = useState<{x: number, y: number, w: number, h: number} | null>(null);
  const [isCroppingMode, setIsCroppingMode] = useState(false);
  const [cropStart, setCropStart] = useState<{x: number, y: number} | null>(null);
  
  const [error, setError] = useState<string | null>(null);
  
  const [startSec, setStartSec] = useState<number>(0);
  const [endSec, setEndSec] = useState<number>(5);
  const [originalCall, setOriginalCall] = useState<string>('');
  
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      setObjects([]);
      setActiveObjectId(1);
      setRawVideoUrl(null);
      setResultVideoUrl(null);
      setYoloVideoUrl(null);
      setAnalysisRaw(null);
      setAnalysisSam(null);
      setAnalysisYolo(null);
      setAnalysisStacked(null);
      setAnalysisStackedSam(null);
      setAnalysisStackedRawSam(null);
      setExtractedNumbers(null);
      setExtractedObjectsCount(null);
      setError(null);
      setIsFrameLocked(false);
      setCropRect(null);
      setIsCroppingMode(false);
      setCropStart(null);
    }
  };

  const captureFrame = async (): Promise<Blob | null> => {
    if (!videoRef.current) return null;
    const video = videoRef.current;
    
    const canvas = document.createElement("canvas");
    const targetW = cropRect && cropRect.w > 0 ? cropRect.w : video.videoWidth;
    const targetH = cropRect && cropRect.h > 0 ? cropRect.h : video.videoHeight;
    canvas.width = targetW;
    canvas.height = targetH;
    
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    
    if (cropRect && cropRect.w > 0 && cropRect.h > 0) {
      ctx.drawImage(video, cropRect.x, cropRect.y, cropRect.w, cropRect.h, 0, 0, targetW, targetH);
    } else {
      ctx.drawImage(video, 0, 0, targetW, targetH);
    }
    
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.95);
    });
  };

  const lockFrame = async () => {
    if (!videoRef.current) return;
    setIsPreviewing(true);
    setError(null);
    try {
      // Force video back to the start frame of the clip before locking
      if (videoRef.current.currentTime !== startSec) {
        videoRef.current.currentTime = startSec;
        await new Promise((resolve) => {
          const onSeeked = () => {
            videoRef.current?.removeEventListener('seeked', onSeeked);
            resolve(true);
          };
          videoRef.current?.addEventListener('seeked', onSeeked);
        });
      }

      const frameBlob = await captureFrame();
      if (!frameBlob) throw new Error("Could not capture frame");
      const formData = new FormData();
      formData.append("image", frameBlob, "frame.jpg");
      
      const res = await fetch("http://localhost:8000/set-image", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      setIsFrameLocked(true);
      setIsCroppingMode(false);
    } catch (err: any) {
      setError(err.message || "Failed to lock frame");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handlePointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!isCroppingMode || !videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const scaleX = videoRef.current.videoWidth / rect.width;
    const scaleY = videoRef.current.videoHeight / rect.height;
    
    setCropStart({ x: x * scaleX, y: y * scaleY });
    setCropRect({ x: x * scaleX, y: y * scaleY, w: 0, h: 0 });
  };

  const handlePointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!isCroppingMode || !cropStart || !videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const scaleX = videoRef.current.videoWidth / rect.width;
    const scaleY = videoRef.current.videoHeight / rect.height;
    
    const currentX = x * scaleX;
    const currentY = y * scaleY;
    
    setCropRect({
      x: Math.min(cropStart.x, currentX),
      y: Math.min(cropStart.y, currentY),
      w: Math.abs(currentX - cropStart.x),
      h: Math.abs(currentY - cropStart.y)
    });
  };

  const handlePointerUp = () => {
    if (!isCroppingMode) return;
    setCropStart(null);
  };

  const handleVideoClick = async (e: MouseEvent<HTMLVideoElement>) => {
    if (!videoRef.current || isPreviewing || !isFrameLocked || isCroppingMode) return;
    
    const rect = videoRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const scaleX = videoRef.current.videoWidth / rect.width;
    const scaleY = videoRef.current.videoHeight / rect.height;
    
    let intrinsicX = x * scaleX;
    let intrinsicY = y * scaleY;
    
    if (cropRect && cropRect.w > 0) {
      intrinsicX -= cropRect.x;
      intrinsicY -= cropRect.y;
      
      // Ignore clicks outside the crop box
      if (intrinsicX < 0 || intrinsicY < 0 || intrinsicX > cropRect.w || intrinsicY > cropRect.h) {
        return;
      }
    }
    
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
      
      const res = await fetch("http://localhost:8000/preview-mask", {
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

  const processRaw = async () => {
    if (!videoFile) return;
    
    setIsProcessingRaw(true);
    setError(null);
    setRawVideoUrl(null);
    setAnalysisRaw(null);
    
    try {
      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("start_sec", startSec.toString());
      formData.append("end_sec", endSec.toString());
      
      if (cropRect && cropRect.w > 0) {
        formData.append("crop_x", cropRect.x.toString());
        formData.append("crop_y", cropRect.y.toString());
        formData.append("crop_w", cropRect.w.toString());
        formData.append("crop_h", cropRect.h.toString());
      }

      const res = await fetch("http://localhost:8000/crop-only", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text());

      const videoBlob = await res.blob();
      const url = URL.createObjectURL(videoBlob);
      setRawVideoUrl(url);
    } catch (err: any) {
      setError(err.message || "Failed to generate raw video");
    } finally {
      setIsProcessingRaw(false);
    }
  };

  const processVideo = async () => {
    if (!videoFile || objects.length === 0) {
      setError("Please select a video and add at least one object.");
      return;
    }
    
    setIsProcessing(true);
    setError(null);
    setResultVideoUrl(null);
    setAnalysisSam(null);
    
    try {
      const promptsPayload = objects.map((obj) => ({
        object_id: obj.id,
        frame_idx: 0, // Frame index is relative to the Start Sec! Since they clicked on the start frame, it's 0.
        points: obj.points.map(p => [p.x, p.y]),
        labels: obj.points.map(() => 1)
      }));

      const formData = new FormData();
      formData.append("video", videoFile);
      formData.append("prompts", JSON.stringify(promptsPayload));
      formData.append("start_sec", startSec.toString());
      formData.append("end_sec", endSec.toString());
      
      if (cropRect && cropRect.w > 0) {
        formData.append("crop_x", cropRect.x.toString());
        formData.append("crop_y", cropRect.y.toString());
        formData.append("crop_w", cropRect.w.toString());
        formData.append("crop_h", cropRect.h.toString());
      }

      const res = await fetch("http://localhost:8000/process-video", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        throw new Error(await res.text() || "Failed to process video");
      }

      const blob = await res.blob();
      setResultVideoUrl(URL.createObjectURL(blob));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const processYolo = async () => {
    if (!resultVideoUrl) return;
    
    setIsProcessingYolo(true);
    setError(null);
    setYoloVideoUrl(null);
    setAnalysisYolo(null);
    
    try {
      const blobRes = await fetch(resultVideoUrl);
      const videoBlobInput = await blobRes.blob();
      
      const formData = new FormData();
      formData.append("video", videoBlobInput, "sam_output.mp4");

      const res = await fetch("http://localhost:8000/process-yolo", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text());

      const videoBlob = await res.blob();
      const videoUrl = URL.createObjectURL(videoBlob);
      setYoloVideoUrl(videoUrl);
      
    } catch (err: any) {
      setError(err.message || "Failed to run YOLO analytics");
    } finally {
      setIsProcessingYolo(false);
    }
  };

  const extractNumbers = async () => {
    if (!resultVideoUrl) return;
    
    setIsExtractingNumbers(true);
    setExtractedNumbers(null);
    setExtractedObjectsCount(null);
    setError(null);
    
    try {
      const blobRes = await fetch(resultVideoUrl);
      const videoBlobInput = await blobRes.blob();
      
      const formData = new FormData();
      formData.append("video", videoBlobInput, "sam_output.mp4");

      const res = await fetch("http://localhost:8000/extract-numbers", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      setExtractedNumbers(data.detected_jersey_numbers || []);
      setExtractedObjectsCount(objects.length); // Use the 100% accurate user selection count!
    } catch (err: any) {
      setError(err.message || "Failed to extract jersey numbers");
    } finally {
      setIsExtractingNumbers(false);
    }
  };

  const runAnalysis = async (type: 'raw' | 'sam' | 'yolo' | 'stacked' | 'stacked-sam' | 'stacked-raw-sam') => {
    let targetUrl = null;
    let secondaryUrl = null;
    
    if (type === 'raw') {
      targetUrl = rawVideoUrl;
      setIsAnalyzingRaw(true);
      setAnalysisRaw(null);
    } else if (type === 'sam') {
      targetUrl = resultVideoUrl;
      setIsAnalyzingSam(true);
      setAnalysisSam(null);
    } else if (type === 'yolo') {
      targetUrl = yoloVideoUrl;
      setIsAnalyzingYolo(true);
      setAnalysisYolo(null);
    } else if (type === 'stacked') {
      targetUrl = rawVideoUrl;
      secondaryUrl = yoloVideoUrl;
      setIsAnalyzingStacked(true);
      setAnalysisStacked(null);
    } else if (type === 'stacked-sam') {
      targetUrl = resultVideoUrl;
      secondaryUrl = yoloVideoUrl;
      setIsAnalyzingStackedSam(true);
      setAnalysisStackedSam(null);
    } else if (type === 'stacked-raw-sam') {
      targetUrl = rawVideoUrl;
      secondaryUrl = resultVideoUrl;
      setIsAnalyzingStackedRawSam(true);
      setAnalysisStackedRawSam(null);
    }
    
    if (!targetUrl || (type.startsWith('stacked') && !secondaryUrl)) {
      if (type.startsWith('stacked')) setError("Stacked analysis requires both videos to be generated.");
      else setError("Video is missing for analysis.");
      setIsAnalyzingRaw(false); setIsAnalyzingSam(false); setIsAnalyzingYolo(false); setIsAnalyzingStacked(false); setIsAnalyzingStackedSam(false); setIsAnalyzingStackedRawSam(false);
      return;
    }
    
    try {
      const blobRes = await fetch(targetUrl);
      const videoBlob = await blobRes.blob();
      const file = new File([videoBlob], `${type}_test.mp4`, { type: 'video/mp4' });
      
      let skeletonFile = undefined;
      if (secondaryUrl) {
        const secBlobRes = await fetch(secondaryUrl);
        const secBlob = await secBlobRes.blob();
        skeletonFile = new File([secBlob], `${type}_skeleton.mp4`, { type: 'video/mp4' });
      }
      
      let cvMetadata: any = undefined;
      if (extractedNumbers && extractedNumbers.length > 0) {
        cvMetadata = { ...cvMetadata, detected_jersey_numbers: extractedNumbers };
      }
      if (extractedObjectsCount !== null) {
        cvMetadata = { ...cvMetadata, explicitly_tracked_object_count: extractedObjectsCount };
      }
      
      const result = await analyzeClip({ 
        video: file, 
        skeletonVideo: skeletonFile, 
        cvMetadata,
        sport: 'soccer', 
        originalCall: originalCall.trim() || null 
      });
      
      if (type === 'raw') setAnalysisRaw(result);
      else if (type === 'sam') setAnalysisSam(result);
      else if (type === 'yolo') setAnalysisYolo(result);
      else if (type === 'stacked') setAnalysisStacked(result);
      else if (type === 'stacked-sam') setAnalysisStackedSam(result);
      else if (type === 'stacked-raw-sam') setAnalysisStackedRawSam(result);
      
    } catch (err: any) {
      setError(err.message || `Failed to analyze ${type} video`);
    } finally {
      if (type === 'raw') setIsAnalyzingRaw(false);
      else if (type === 'sam') setIsAnalyzingSam(false);
      else if (type === 'yolo') setIsAnalyzingYolo(false);
      else if (type === 'stacked') setIsAnalyzingStacked(false);
      else if (type === 'stacked-sam') setIsAnalyzingStackedSam(false);
      else if (type === 'stacked-raw-sam') setIsAnalyzingStackedRawSam(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">
      <h1 className="text-3xl font-bold">Interactive Object Selector</h1>
      
      <div className="space-y-4">
        <input 
          type="file" 
          accept="video/mp4,video/webm" 
          onChange={handleFileChange}
          className="block w-full border p-2 rounded"
        />
        
        {videoUrl && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm mb-1">Start Time: {startSec.toFixed(2)}s</label>
              <input type="range" min="0" max={videoRef.current?.duration || 100} step="0.01" value={startSec} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setStartSec(val);
                setIsFrameLocked(false);
                setObjects([]);
                setActiveObjectId(1);
                setCropRect(null);
                setIsCroppingMode(false);
                if (videoRef.current) {
                  videoRef.current.currentTime = val;
                }
              }} className="w-full cursor-ew-resize" />
            </div>
            <div>
              <label className="block text-sm mb-1">End Time: {endSec.toFixed(2)}s</label>
              <input type="range" min="0" max={videoRef.current?.duration || 100} step="0.01" value={endSec} onChange={(e) => {
                const val = parseFloat(e.target.value);
                setEndSec(val);
                if (videoRef.current) videoRef.current.currentTime = val;
              }} className="w-full cursor-ew-resize" />
            </div>
          </div>
        )}
        
        {videoUrl && (
          <div className="mt-4">
            <label className="block text-sm mb-1 font-semibold text-gray-300">Original Call on the Field (Optional):</label>
            <input 
              type="text" 
              placeholder='e.g. "Foul on the defender", "Offside", "Penalty"' 
              value={originalCall}
              onChange={(e) => setOriginalCall(e.target.value)}
              className="block w-full border border-gray-700 bg-gray-900 text-white p-3 rounded shadow-inner placeholder-gray-500"
            />
            <p className="text-xs text-gray-400 mt-1">Providing this helps the AI filter out irrelevant information (like a handball across the field when you only care about a specific tackle).</p>
          </div>
        )}
      </div>

      {error && <div className="p-4 bg-red-500/20 text-red-500 rounded">{error}</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {videoUrl && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">1. Select Objects</h2>
            
            {!isFrameLocked ? (
              <div className="bg-blue-500/10 border border-blue-500/30 p-4 rounded text-center space-y-3">
                <p className="text-sm">Found the perfect start frame? Lock it in to start selecting.</p>
                <div className="flex gap-2 justify-center">
                  <button 
                    onClick={() => {
                      if (isCroppingMode) {
                         setIsCroppingMode(false);
                      } else {
                         setIsCroppingMode(true);
                         setCropRect(null);
                      }
                    }}
                    className={`px-4 py-2 font-medium rounded border ${isCroppingMode ? 'bg-green-600 text-white border-green-600' : 'bg-transparent text-green-500 border-green-500 hover:bg-green-500/10'}`}
                  >
                    {isCroppingMode ? "Done Cropping" : "Draw Crop Box"}
                  </button>
                  <button 
                    onClick={lockFrame}
                    disabled={isPreviewing || isCroppingMode}
                    className="px-4 py-2 bg-blue-600 text-white font-medium rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isPreviewing ? "Locking..." : "Lock Frame & Start"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400">Click on the video to highlight objects (Max 5). Be sure to select on your intended Start Time.</p>
            )}
            
            <div 
              className={`relative inline-block border rounded overflow-hidden shadow-lg ${(!isFrameLocked && !isCroppingMode) && 'opacity-50 pointer-events-none'}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            >
              {/* The Video */}
              <video 
                ref={videoRef}
                src={videoUrl} 
                className={`max-w-full h-auto ${isPreviewing ? 'cursor-wait' : (isFrameLocked ? 'cursor-crosshair' : '')}`}
                onClick={handleVideoClick}
                onLoadedMetadata={(e) => {
                  e.currentTarget.currentTime = startSec;
                  if (endSec === 5) setEndSec(Math.min(5, e.currentTarget.duration));
                }}
              />
              
              {/* Crop Overlay */}
              {cropRect && cropRect.w > 0 && (
                <div 
                  className="absolute border-2 border-dashed border-green-500 bg-green-500/10 pointer-events-none"
                  style={{
                    left: `${(cropRect.x / (videoRef.current?.videoWidth || 1)) * 100}%`,
                    top: `${(cropRect.y / (videoRef.current?.videoHeight || 1)) * 100}%`,
                    width: `${(cropRect.w / (videoRef.current?.videoWidth || 1)) * 100}%`,
                    height: `${(cropRect.h / (videoRef.current?.videoHeight || 1)) * 100}%`
                  }}
                />
              )}
              
              {/* The Masks and Dots */}
              {objects.map((obj) => (
                <div 
                  key={obj.id} 
                  className="absolute pointer-events-none"
                  style={cropRect && cropRect.w > 0 ? {
                    left: `${(cropRect.x / (videoRef.current?.videoWidth || 1)) * 100}%`,
                    top: `${(cropRect.y / (videoRef.current?.videoHeight || 1)) * 100}%`,
                    width: `${(cropRect.w / (videoRef.current?.videoWidth || 1)) * 100}%`,
                    height: `${(cropRect.h / (videoRef.current?.videoHeight || 1)) * 100}%`
                  } : {
                    left: 0, top: 0, width: "100%", height: "100%"
                  }}
                >
                  {/* Mask Overlay */}
                  <img 
                    src={obj.maskUrl}
                    className="absolute top-0 left-0 w-full h-full"
                    alt={`Mask ${obj.id}`}
                  />
                  {/* Visual Click Dots */}
                  {obj.points.map((pt, idx) => (
                    <div 
                      key={idx}
                      className="absolute w-3 h-3 rounded-full border border-white transform -translate-x-1/2 -translate-y-1/2 shadow-sm"
                      style={{ 
                        left: `${(pt.x / (cropRect && cropRect.w > 0 ? cropRect.w : (videoRef.current?.videoWidth || 1))) * 100}%`,
                        top: `${(pt.y / (cropRect && cropRect.h > 0 ? cropRect.h : (videoRef.current?.videoHeight || 1))) * 100}%`,
                        backgroundColor: obj.color.hex
                      }}
                    />
                  ))}
                </div>
              ))}
              
              {isPreviewing && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center text-white font-semibold pointer-events-none">
                  Generating Preview...
                </div>
              )}
            </div>
            
            {/* Object List */}
            {objects.length > 0 && (
              <div className="space-y-2 border p-4 rounded shadow-sm">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="font-semibold text-sm uppercase text-gray-500">Selected Objects</h3>
                  <button onClick={() => { setObjects([]); setActiveObjectId(1); }} className="text-xs text-gray-400 hover:text-white">Clear All</button>
                </div>
                {objects.map((obj) => (
                  <div key={obj.id} 
                    className={`flex items-center justify-between p-2 rounded cursor-pointer border transition-colors ${activeObjectId === obj.id ? 'bg-black/40 border-gray-500' : 'bg-black/20 border-transparent hover:bg-black/30'}`}
                    onClick={() => setActiveObjectId(obj.id)}
                  >
                    <div className="flex items-center space-x-3">
                      <div className="w-4 h-4 rounded-full border border-gray-600" style={{ backgroundColor: obj.color.hex }} />
                      <span className="text-sm font-medium">Object {obj.id} ({obj.points.length} points)</span>
                    </div>
                    <button 
                      onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }}
                      className="text-red-500 text-xs hover:underline bg-red-500/10 px-2 py-1 rounded"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                
                {objects.length < 5 && (
                  <button 
                    onClick={() => setActiveObjectId(objects.length > 0 ? Math.max(...objects.map(o => o.id)) + 1 : 1)}
                    className="w-full py-2 mt-2 text-sm border border-dashed rounded text-gray-400 hover:text-white hover:border-gray-400"
                  >
                    + Add New Object
                  </button>
                )}
              </div>
            )}
            
            <div className="mt-6 flex flex-col gap-3 w-full">
              <button 
                onClick={processRaw}
                disabled={isProcessingRaw || isProcessing || isProcessingYolo}
                className="w-full py-3 bg-gray-700 text-white font-semibold rounded hover:bg-gray-600 disabled:opacity-50 transition-colors"
              >
                {isProcessingRaw ? "Generating Raw..." : "1. Generate Raw Cropped Video"}
              </button>
              <button 
                onClick={processVideo}
                disabled={isProcessing || isProcessingYolo || objects.length === 0}
                className="w-full py-3 bg-white text-black font-semibold rounded hover:bg-gray-200 disabled:opacity-50 transition-colors"
              >
                {isProcessing ? "Processing SAM 2..." : "2. Process SAM 2 Tracking"}
              </button>
            </div>
          </div>
        )}

        {(rawVideoUrl || resultVideoUrl || yoloVideoUrl) && (
          <div className="space-y-8">
            {rawVideoUrl && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold">A. Raw Cropped Result</h2>
                <div className="border rounded bg-black shadow-lg overflow-hidden">
                  <video src={rawVideoUrl} controls autoPlay loop className="max-w-full h-auto w-full" />
                </div>
                
                <div className="pt-2">
                  <button onClick={() => runAnalysis('raw')} disabled={isAnalyzingRaw} className="w-full py-2 bg-blue-600 text-white font-semibold rounded hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-lg">
                    {isAnalyzingRaw ? "Analyzing Raw..." : "Analyze with AI (Raw)"}
                  </button>
                </div>
                
                {analysisRaw && (
                  <div className="p-4 bg-gray-900 border border-gray-700 rounded text-sm space-y-2 text-white shadow-inner">
                    {isAnalyzeError(analysisRaw) ? (
                      <p className="text-red-400 font-medium">Error: {analysisRaw.error}</p>
                    ) : (
                      <>
                        <p><span className="font-bold text-blue-400">Verdict:</span> {analysisRaw.verdict}</p>
                        <p><span className="font-bold text-gray-400">Description:</span> {analysisRaw.playDescription}</p>
                        <p><span className="font-bold text-gray-400">Reasoning:</span> {analysisRaw.reasoning}</p>
                        <p><span className="font-bold text-gray-400">Confidence:</span> {analysisRaw.confidence}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {resultVideoUrl && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold">B. SAM 2 Result</h2>
                <div className="border rounded bg-black shadow-lg overflow-hidden">
                  <video 
                    src={resultVideoUrl} 
                    controls
                    autoPlay
                    loop
                    className="max-w-full h-auto w-full"
                  />
                </div>
                
                <div className="pt-2 grid grid-cols-1 gap-4">
                  <button 
                    onClick={() => runAnalysis('sam')} 
                    disabled={isAnalyzingSam} 
                    className="w-full py-2 bg-blue-600 text-white font-semibold rounded hover:bg-blue-700 disabled:opacity-50 transition-colors shadow-lg"
                  >
                    {isAnalyzingSam ? "Analyzing SAM..." : "Analyze with AI (SAM 2)"}
                  </button>
                </div>
                
                <div className="pt-2">
                  <button 
                    onClick={extractNumbers} 
                    disabled={isExtractingNumbers} 
                    className="w-full py-2 bg-indigo-600 text-white font-semibold rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-lg border border-indigo-400"
                  >
                    {isExtractingNumbers ? "Extracting Jersey Numbers..." : "4. Extract Jersey Numbers (OCR)"}
                  </button>
                </div>
                
                {extractedNumbers !== null && (
                  <div className="mt-2 p-3 bg-indigo-900 border border-indigo-500 rounded text-indigo-100 text-sm shadow-inner space-y-1">
                    <p><strong>Detected Jersey Numbers: </strong> {extractedNumbers.length > 0 ? extractedNumbers.join(", ") : "None detected"}</p>
                    {extractedObjectsCount !== null && <p><strong>Total Objects Explicitly Tracked: </strong> {extractedObjectsCount}</p>}
                  </div>
                )}
                
                {analysisSam && (
                  <div className="p-4 bg-gray-900 border border-gray-700 rounded text-sm space-y-2 text-white shadow-inner">
                    {isAnalyzeError(analysisSam) ? (
                      <p className="text-red-400 font-medium">Error: {analysisSam.error}</p>
                    ) : (
                      <>
                        <p><span className="font-bold text-blue-400">Verdict:</span> {analysisSam.verdict}</p>
                        <p><span className="font-bold text-gray-400">Description:</span> {analysisSam.playDescription}</p>
                        <p><span className="font-bold text-gray-400">Reasoning:</span> {analysisSam.reasoning}</p>
                        <p><span className="font-bold text-gray-400">Confidence:</span> {analysisSam.confidence}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {(rawVideoUrl && resultVideoUrl) && (
              <div className="space-y-4 pt-8 border-t border-gray-700">
                <h2 className="text-2xl font-bold text-purple-400">F. Stacked Context (Raw + SAM 2)</h2>
                <p className="text-gray-300 text-sm">Sends the original raw video for visual context and the SAM 2 isolated objects (bypassing YOLO completely).</p>
                <div className="pt-2">
                  <button onClick={() => runAnalysis('stacked-raw-sam')} disabled={isAnalyzingStackedRawSam} className="w-full py-4 bg-purple-600 text-white font-bold text-lg rounded hover:bg-purple-700 disabled:opacity-50 transition-colors shadow-xl border border-purple-400">
                    {isAnalyzingStackedRawSam ? "Analyzing Stacked Raw+SAM Context..." : "Analyze with AI (Raw + SAM 2)"}
                  </button>
                </div>
                
                {analysisStackedRawSam && (
                  <div className="p-6 bg-gray-900 border-2 border-purple-500 rounded space-y-3 text-white shadow-inner">
                    {isAnalyzeError(analysisStackedRawSam) ? (
                      <p className="text-red-400 font-medium text-lg">Error: {analysisStackedRawSam.error}</p>
                    ) : (
                      <>
                        <p className="text-lg"><span className="font-bold text-purple-400">Verdict:</span> {analysisStackedRawSam.verdict}</p>
                        <p><span className="font-bold text-gray-400">Description:</span> {analysisStackedRawSam.playDescription}</p>
                        <p><span className="font-bold text-gray-400">Reasoning:</span> {analysisStackedRawSam.reasoning}</p>
                        <p><span className="font-bold text-gray-400">Confidence:</span> {analysisStackedRawSam.confidence}</p>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

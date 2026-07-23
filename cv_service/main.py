from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
import cv2
import base64
import os
import tempfile
from ultralytics import YOLO

app = FastAPI(title="DropRef CV Service")

# Load a lightweight YOLOv8 pose model for tracking and skeletal keypoints
model = YOLO('yolov8n-pose.pt')

@app.post("/track")
async def track_video(video: UploadFile = File(...)):
    # 1. Save uploaded video to a temporary file
    temp_dir = tempfile.mkdtemp()
    input_path = os.path.join(temp_dir, "input.mp4")
    
    with open(input_path, "wb") as f:
        f.write(await video.read())
        
    # 2. Run Ultralytics object tracking
    # We use persist=True to maintain track IDs across frames
    # We use stream=True to prevent accumulating results in RAM and avoid OOM warnings
    results_generator = model.track(source=input_path, persist=True, stream=True)
    
    output_path = os.path.join(temp_dir, "output.mp4")
    unique_ids = set()
    
    out = None
    frame_count = 0
    
    for r in results_generator:
        frame_count += 1
        if out is None:
            first_frame = r.plot()
            height, width, _ = first_frame.shape
            fourcc = cv2.VideoWriter_fourcc(*'avc1')
            out = cv2.VideoWriter(output_path, fourcc, 30.0, (width, height))
            
        if r.boxes is not None and r.boxes.id is not None:
            unique_ids.update(r.boxes.id.cpu().numpy().tolist())
            
        annotated_frame = r.plot()
        out.write(annotated_frame)
        
    if out is not None:
        out.release()
    else:
        output_path = input_path
            
    metadata = {
        "unique_objects_tracked": len(unique_ids),
        "frame_count": frame_count,
        "note": "YOLOv8-Pose tracking data with skeletal keypoints"
    }
    
    with open(output_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode('utf-8')
        
    return JSONResponse(content={
        "metadata": metadata,
        "videoBase64": video_b64,
        "mimeType": "video/mp4"
    })

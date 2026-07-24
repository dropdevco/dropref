from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import cv2
import base64
import os
import tempfile
import math
import numpy as np
from ultralytics import RTDETR
from deep_sort_realtime.deepsort_tracker import DeepSort
from paddleocr import PaddleOCR

app = FastAPI(title="RefCheck AI CV Service")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load Models
print("Loading RT-DETR...")
# Using RT-DETR for high-accuracy bounding boxes
model = RTDETR("rtdetr-l.pt")

print("Loading PaddleOCR...")
# use_angle_cls=True to handle text rotation, lang='en' for English
ocr = PaddleOCR(use_angle_cls=True, lang='en')

@app.post("/track")
async def track_video(video: UploadFile = File(...)):
    # 1. Save uploaded video to a temporary file
    temp_dir = tempfile.mkdtemp()
    input_path = os.path.join(temp_dir, "input.mp4")
    
    with open(input_path, "wb") as f:
        f.write(await video.read())
        
    annotated_path = os.path.join(temp_dir, "annotated.mp4")
    
    # ---------------------------------------------------------
    # Analysis & Annotation Pass
    # ---------------------------------------------------------
    
    # Initialize DeepSORT
    tracker = DeepSort(max_age=30, n_init=3, nms_max_overlap=1.0)
    
    cap = cv2.VideoCapture(input_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    H = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    print(f"\n[CV Pipeline] Starting new tracking job...")
    print(f"[CV Pipeline] Total Frames: {total_frames} | Resolution: {W}x{H} | FPS: {fps}")
    
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(annotated_path, fourcc, fps, (W, H))
    
    frame_count = 0
    current_bbs = []
    current_ball_boxes = []
    telemetry_events = []
    
    last_bx, last_by = None, None
    last_dx, last_dy = 0.0, 0.0
    last_speed = 0.0
    
    while True:
        ret, frame = cap.read()
        if not ret:
            break
            
        frame_count += 1
        
        print(f"[CV Pipeline] Processing frame {frame_count}/{total_frames}...")
        
        # Calculate dynamic frame skip based on video progress
        # First 25% and last 25% of video: heavy skipping (every 10 frames)
        # Middle 50% of video (the action): light skipping (every 3 frames)
        progress = frame_count / total_frames if total_frames > 0 else 0.5
        if progress < 0.25 or progress > 0.75:
            frame_skip = 10
        else:
            frame_skip = 3
        
        # 1. Periodically run OCR (e.g., once every 30 frames) to find scoreboard text
        if frame_count % 30 == 1:
            ocr_result = ocr.ocr(frame)
            text_found = []
            if ocr_result and ocr_result[0]:
                for line in ocr_result[0]:
                    try:
                        text_tuple = line[1]
                        if isinstance(text_tuple, (tuple, list)) and len(text_tuple) >= 2:
                            text = text_tuple[0]
                            conf = text_tuple[1]
                            if conf > 0.7:
                                text_found.append(text)
                        elif isinstance(text_tuple, str):
                            text_found.append(text_tuple)
                    except Exception:
                        pass
            
            if text_found:
                telemetry_events.append({
                    "frame": frame_count,
                    "event": "OCR_TEXT_DETECTED",
                    "text": " | ".join(text_found)
                })

        # 2. Run Object Detection via RT-DETR (Dynamic Frame Skip)
        run_ai = (frame_count % frame_skip == 1)
        
        if run_ai:
            # Running on CPU. (MPS causes a hard segfault with RT-DETR on Mac)
            results = model(frame, conf=0.25, verbose=False)[0]
            
            bbs = []
            ball_boxes = []
            
            if results.boxes is not None and len(results.boxes) > 0:
                for box in results.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    conf = float(box.conf[0].cpu().numpy())
                    cls = int(box.cls[0].cpu().numpy())
                    
                    w = x2 - x1
                    h = y2 - y1
                    
                    if cls == 0: # Person
                        bbs.append(([x1, y1, w, h], conf, "person"))
                    elif cls == 32: # Sports Ball
                        ball_boxes.append((x1, y1, x2, y2))
                        
            current_bbs = bbs
            current_ball_boxes = ball_boxes
                    
            # 3. Update DeepSORT Tracker (Players)
            # Only update the tracker when we actually have fresh detections
            # This completely avoids DeepSORT's internal CNN on skipped frames
            current_tracks = tracker.update_tracks(current_bbs, frame=frame)
        
        person_centers = []
        
        # Ensure current_tracks is defined for the very first frame even if somehow missed
        if 'current_tracks' not in locals():
            current_tracks = []
        
        for track in current_tracks:
            if not track.is_confirmed():
                continue
            
            track_id = track.track_id
            ltrb = track.to_ltrb()
            
            # Draw player bbox and ID
            x1, y1, x2, y2 = map(int, ltrb)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 0, 0), 2)
            cv2.putText(frame, f"ID: {track_id}", (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)
            
            cx = (x1 + x2) / 2.0
            cy = (y1 + y2) / 2.0
            person_centers.append((cx, cy, track_id))
            
        # Detect Player Collisions based on tracked centers
        for i in range(len(person_centers)):
            for j in range(i + 1, len(person_centers)):
                c1 = person_centers[i]
                c2 = person_centers[j]
                dist = math.hypot(c1[0] - c2[0], c1[1] - c2[1])
                if dist < 40: # Pixel threshold for close proximity
                    telemetry_events.append({
                        "frame": frame_count,
                        "event": "PLAYER_PROXIMITY_DETECTED",
                        "ids": [c1[2], c2[2]],
                        "distance": round(dist, 1)
                    })
                    
        # 4. Process Ball Telemetry
        if current_ball_boxes:
            best_bx, best_by = None, None
            if last_bx is not None and last_by is not None:
                # Project predicted location based on momentum
                pred_x = last_bx + last_dx
                pred_y = last_by + last_dy
                
                min_dist = float('inf')
                for box in current_ball_boxes:
                    cx = (box[0] + box[2]) / 2.0
                    cy = (box[1] + box[3]) / 2.0
                    dist = math.hypot(cx - pred_x, cy - pred_y)
                    if dist < min_dist:
                        min_dist = dist
                        best_bx, best_by = cx, cy
                        
                # Update momentum velocity
                last_dx = best_bx - last_bx
                last_dy = best_by - last_by
                
                current_speed = math.hypot(last_dx, last_dy)
                acceleration = current_speed - last_speed
                
                # Detect massive velocity spikes (Kicks/Passes/Deflections)
                if acceleration > 25.0:
                    telemetry_events.append({
                        "frame": frame_count,
                        "event": "BALL_ACCELERATION_SPIKE",
                        "velocity": round(current_speed, 1),
                        "acceleration": round(acceleration, 1)
                    })
                last_speed = current_speed
            else:
                best_bx = (current_ball_boxes[0][0] + current_ball_boxes[0][2]) / 2.0
                best_by = (current_ball_boxes[0][1] + current_ball_boxes[0][3]) / 2.0
                last_dx, last_dy = 0.0, 0.0
                last_speed = 0.0
                
            bx, by = best_bx, best_by
            last_bx, last_by = bx, by
            
            # Draw Ball
            cv2.circle(frame, (int(bx), int(by)), 15, (0, 255, 255), 3)
            cv2.putText(frame, "BALL", (int(bx)-20, int(by)-20), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
            
        else:
            # Ball not found this frame, decay momentum
            last_dx *= 0.8
            last_dy *= 0.8
            last_speed *= 0.8
            
        # Write to intermediate video
        out.write(frame)
        
    cap.release()
    out.release()
    
    print(f"[CV Pipeline] Job complete! Processed {frame_count} frames.")
        
    metadata = {
        "frame_count": frame_count,
        "fps": fps,
        "note": "RT-DETR + DeepSORT Tracking",
        "telemetry": telemetry_events,
    }
    
    # Return the video and metadata
    with open(annotated_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode('utf-8')
        
    return JSONResponse(content={
        "metadata": metadata,
        "videoBase64": video_b64,
        "mimeType": "video/mp4"
    })

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import cv2
import base64
import os
import tempfile
from ultralytics import YOLO
from synthetic_renderer.renderer import SyntheticRenderer

app = FastAPI(title="DropRef CV Service")

# Add CORS middleware to allow the Next.js frontend to talk to this service directly if needed
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Load YOLO models
# Pose model upgraded to Extra Large (x) to ensure NO players are missed
model = YOLO("yolov8x-pose.pt")
# Object model upgraded to Medium (m) to accurately detect small sports balls
model_obj = YOLO("yolov8m.pt")

@app.post("/track")
async def track_video(video: UploadFile = File(...)):
    # 1. Save uploaded video to a temporary file
    temp_dir = tempfile.mkdtemp()
    input_path = os.path.join(temp_dir, "input.mp4")
    
    with open(input_path, "wb") as f:
        f.write(await video.read())
        
    annotated_path = os.path.join(temp_dir, "annotated.mp4")
    synthetic_path = os.path.join(temp_dir, "synthetic.mp4")
    output_path = os.path.join(temp_dir, "output.mp4")
    
    # ---------------------------------------------------------
    # PASS 1: Analysis & Annotation Pass
    # Run YOLO with ByteTrack (disables GMC to prevent OpenCV pyramid errors)
    # We explicitly set imgsz=1280 (double resolution) and lower conf=0.15 so it catches tiny players far away!
    # ---------------------------------------------------------
    results_generator = model.track(source=input_path, persist=True, stream=True, tracker="bytetrack.yaml", imgsz=1280, conf=0.15)
    
    target_cxs = []
    target_cys = []
    unique_ids = set()
    
    import math
    import statistics
    import numpy as np
    
    W, H = None, None
    crop_w, crop_h = None, None
    annotated_out = None
    renderer = None
    frame_count = 0
    
    heatmap = None
    last_bx, last_by = None, None
    last_dx, last_dy = 0.0, 0.0
    last_speed = 0.0
    telemetry_events = []
    
    player_color_history = {} # pid -> list of BGR colors
    
    for frame_idx, r in enumerate(results_generator):
        frame_count += 1
        annotated_frame = r.plot()
        
        if W is None:
            H, W, _ = annotated_frame.shape
            
            fourcc = cv2.VideoWriter_fourcc(*'avc1')
            annotated_out = cv2.VideoWriter(annotated_path, fourcc, 30.0, (W, H))
            renderer = SyntheticRenderer(W, H, fps=30)
            
        bx, by = None, None
        
        if r.boxes is not None and len(r.boxes) > 0:
            if r.boxes.id is not None:
                unique_ids.update(r.boxes.id.cpu().numpy().tolist())
                
            boxes = r.boxes.xyxy.cpu().numpy()
            cxs = (boxes[:, 0] + boxes[:, 2]) / 2.0
            cys = (boxes[:, 1] + boxes[:, 3]) / 2.0
            
            # Detect Player Collisions (Fouls/Tackles)
            for i in range(len(cxs)):
                for j in range(i + 1, len(cxs)):
                    dist = math.hypot(cxs[i] - cxs[j], cys[i] - cys[j])
                    if dist < 30: # 30 pixels threshold for intersection
                        telemetry_events.append({
                            "frame": frame_count,
                            "event": "PLAYER_COLLISION_DETECTED",
                            "distance": round(dist, 1)
                        })
            
            # Increased confidence to 0.3 to filter out noise
            r_obj = model_obj(r.orig_img, conf=0.3, imgsz=1280, classes=[32], verbose=False)[0]
            if r_obj.boxes is not None and len(r_obj.boxes) > 0:
                ball_boxes = r_obj.boxes.xyxy.cpu().numpy()
                
                best_bx, best_by = None, None
                if last_bx is not None and last_by is not None:
                    # Project predicted location based on momentum
                    pred_x = last_bx + last_dx
                    pred_y = last_by + last_dy
                    
                    min_dist = float('inf')
                    for box in ball_boxes:
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
                            "event": "BALL_KICKED",
                            "velocity": round(current_speed, 1),
                            "acceleration": round(acceleration, 1)
                        })
                    last_speed = current_speed
                    
                else:
                    best_bx = (ball_boxes[0, 0] + ball_boxes[0, 2]) / 2.0
                    best_by = (ball_boxes[0, 1] + ball_boxes[0, 3]) / 2.0
                    last_dx, last_dy = 0.0, 0.0
                    last_speed = 0.0
                    
                bx, by = best_bx, best_by
                last_bx, last_by = bx, by
                
                cv2.circle(annotated_frame, (int(bx), int(by)), 20, (0, 255, 255), 4)
                cv2.putText(annotated_frame, "BALL DETECTED", (int(bx)-40, int(by)-30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
            
            # Extract raw keypoints for the synthetic renderer
            if hasattr(r, 'keypoints') and r.keypoints is not None and r.keypoints.xy is not None:
                kpts = r.keypoints.xy.cpu().numpy()
                ids_list = []
                if r.boxes.id is not None:
                    ids_list = r.boxes.id.cpu().numpy().astype(int).tolist()
                else:
                    ids_list = list(range(9000, 9000 + len(kpts)))
                
                # Verify length match
                if len(kpts) == len(ids_list):
                    renderer.add_frame_data(kpts, ids_list, bx, by)
                    
                    # Extract Jersey Colors for K-Means Clustering
                    for idx, pid in enumerate(ids_list):
                        if pid not in player_color_history:
                            player_color_history[pid] = []
                            
                        # Get player bounding box
                        if idx < len(boxes):
                            x1, y1, x2, y2 = map(int, boxes[idx])
                            # Clamp bounds
                            x1, y1 = max(0, x1), max(0, y1)
                            x2, y2 = min(W, x2), min(H, y2)
                            
                            # Extract top 20% to 50% for jersey
                            jy1 = y1 + int((y2 - y1) * 0.2)
                            jy2 = y1 + int((y2 - y1) * 0.5)
                            
                            if jy2 > jy1 and x2 > x1:
                                crop = r.orig_img[jy1:jy2, x1:x2]
                                if crop.size > 0:
                                    # Calculate average BGR color
                                    avg_color = np.mean(crop, axis=(0, 1))
                                    player_color_history[pid].append(avg_color)
                else:
                    renderer.add_frame_data([], [], bx, by)
            else:
                renderer.add_frame_data([], [], bx, by)
        else:
            if renderer is not None:
                renderer.add_frame_data([], [], None, None)
            
        # Write to intermediate video
        annotated_out.write(annotated_frame)
        
    if annotated_out is not None:
        annotated_out.release()
        
    # ---------------------------------------------------------
    # PASS 2: K-Means Team Clustering & Synthetic Render
    # ---------------------------------------------------------
    team_assignments = {}
    if player_color_history:
        # Get ultimate median color for each tracked player
        pids = []
        median_colors = []
        for pid, colors in player_color_history.items():
            if len(colors) > 5: # Require at least 5 frames of tracking
                pids.append(pid)
                median_colors.append(np.median(colors, axis=0))
                
        if len(median_colors) >= 2:
            colors_np = np.float32(median_colors)
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
            _, labels, centers = cv2.kmeans(colors_np, 2, None, criteria, 10, cv2.KMEANS_RANDOM_CENTERS)
            
            for idx, pid in enumerate(pids):
                team_idx = int(labels[idx][0])
                center_color = centers[team_idx]
                dist = np.linalg.norm(median_colors[idx] - center_color)
                
                # Flag extreme color outliers as Goalkeepers / Referees
                if dist > 45.0:
                    team_assignments[pid] = -1
                else:
                    team_assignments[pid] = team_idx
                
    # Generate the perfectly smooth synthetic video!
    if renderer is not None:
        renderer.render_video(synthetic_path, team_assignments, telemetry_events)
        
    metadata = {
        "unique_objects_tracked": len(unique_ids),
        "frame_count": frame_count,
        "note": "Synthetic Smooth Render",
        "telemetry": telemetry_events,
    }
    
    # Return the videos
    with open(annotated_path, "rb") as f:
        video_b64 = base64.b64encode(f.read()).decode('utf-8')
        
    with open(synthetic_path, "rb") as f:
        skeleton_b64 = base64.b64encode(f.read()).decode('utf-8')
        
    return JSONResponse(content={
        "metadata": metadata,
        "videoBase64": video_b64,
        "skeletonBase64": skeleton_b64,
        "mimeType": "video/mp4"
    })

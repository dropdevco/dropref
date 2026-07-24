import cv2
import tempfile
import os
from ultralytics import YOLO

model = YOLO('cv_service/yolov8n-pose.pt')
results_generator = model.track(source='public/samples/soccer-offside.mp4', persist=True, stream=True)

out = None
alpha = 0.15
ema_cx, ema_cy = None, None
crop_w, crop_h = None, None
output_path = 'test_local_crop.mp4'

for r in results_generator:
    annotated_frame = r.plot()
    H, W, _ = annotated_frame.shape
    
    if crop_w is None:
        crop_w = int(W * 0.6)
        crop_h = int(H * 0.6)
        if crop_w % 2 != 0: crop_w += 1
        if crop_h % 2 != 0: crop_h += 1

    if out is None:
        fourcc = cv2.VideoWriter_fourcc(*'avc1')
        out = cv2.VideoWriter(output_path, fourcc, 30.0, (crop_w, crop_h))
        
    if r.boxes is not None and len(r.boxes) > 0:
        boxes = r.boxes.xyxy.cpu().numpy()
        cxs = (boxes[:, 0] + boxes[:, 2]) / 2.0
        cys = (boxes[:, 1] + boxes[:, 3]) / 2.0
        avg_cx = cxs.mean()
        avg_cy = cys.mean()
        if ema_cx is None:
            ema_cx, ema_cy = avg_cx, avg_cy
        else:
            ema_cx = alpha * avg_cx + (1 - alpha) * ema_cx
            ema_cy = alpha * avg_cy + (1 - alpha) * ema_cy
            
    if ema_cx is None:
        ema_cx, ema_cy = W / 2.0, H / 2.0
        
    x1 = int(ema_cx - crop_w / 2)
    x2 = int(ema_cx + crop_w / 2)
    y1 = int(ema_cy - crop_h / 2)
    y2 = int(ema_cy + crop_h / 2)
    
    if x1 < 0:
        x1 = 0
        x2 = crop_w
    elif x2 > W:
        x2 = W
        x1 = W - crop_w
        
    if y1 < 0:
        y1 = 0
        y2 = crop_h
    elif y2 > H:
        y2 = H
        y1 = H - crop_h
        
    cropped_frame = annotated_frame[y1:y2, x1:x2]
    out.write(cropped_frame)

if out is not None:
    out.release()
print("Success! Size:", os.path.getsize(output_path))

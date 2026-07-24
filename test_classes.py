from ultralytics import YOLO
model = YOLO('cv_service/yolov8n-pose.pt')
print(model.names)

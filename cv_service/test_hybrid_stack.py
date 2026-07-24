import os
import json
import base64
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_pipeline():
    # Check if a test video exists
    video_path = "../test_local_crop.mp4"
    if not os.path.exists(video_path):
        print(f"Test video '{video_path}' not found. Please provide one.")
        return
        
    print(f"Testing hybrid pipeline with {video_path}...")
    
    try:
        with open(video_path, 'rb') as f:
            files = {'video': (video_path, f, 'video/mp4')}
            response = client.post("/track", files=files)
            
        if response.status_code == 200:
            data = response.json()
            metadata = data.get('metadata')
            print("--- Pipeline Success ---")
            print("Metadata Output:")
            print(json.dumps(metadata, indent=2))
            
            # Optionally save the output video
            out_path = "test_output_annotated.mp4"
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(data['videoBase64']))
            print(f"Saved annotated video to {out_path}")
            
        else:
            print(f"Pipeline failed with status code: {response.status_code}")
            print(response.text)
            
    except Exception as e:
        import traceback
        print(f"Error testing pipeline:")
        traceback.print_exc()

if __name__ == "__main__":
    test_pipeline()

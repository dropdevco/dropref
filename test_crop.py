import requests
import base64

with open('public/samples/soccer-offside.mp4', 'rb') as f:
    files = {'video': ('soccer-offside.mp4', f, 'video/mp4')}
    response = requests.post('http://127.0.0.1:8000/track', files=files)

if response.status_code == 200:
    data = response.json()
    b64 = data['videoBase64']
    with open('cropped_output.mp4', 'wb') as f:
        f.write(base64.b64decode(b64))
    print("SUCCESS, cropped_output.mp4 created.")
else:
    print("FAILED", response.status_code, response.text)

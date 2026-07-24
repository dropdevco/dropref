import { NextResponse } from 'next/server';

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const videoFile = formData.get('video') as File | null;

    if (!videoFile) {
      return NextResponse.json({ error: 'No video file provided' }, { status: 400 });
    }

    // Forward the file directly to the Python CV service
    const pythonFormData = new FormData();
    pythonFormData.append('video', videoFile);

    const cvResponse = await fetch('http://127.0.0.1:8000/track', {
      method: 'POST',
      body: pythonFormData as any, // TypeScript expects browser FormData, node fetch takes it fine
    });

    if (!cvResponse.ok) {
      const err = await cvResponse.text();
      return NextResponse.json({ error: `CV Service Error: ${err}` }, { status: cvResponse.status });
    }

    const data = await cvResponse.json();
    
    return NextResponse.json(data);

  } catch (error: any) {
    console.error('CV Test API Error:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

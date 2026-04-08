// api/tryon.js — CRIATech Virtual Try-On
// Fal.ai IDM-VTON correct integration
// Docs: https://fal.ai/models/fal-ai/idm-vton

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) {
    console.error('FAL_API_KEY not set in environment');
    return res.status(500).json({ error: 'API key not configured' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { personImage, garmentImage, garmentDescription } = body || {};
  if (!personImage || !garmentImage) {
    return res.status(400).json({ error: 'Missing personImage or garmentImage' });
  }

  try {
    // Convert base64 to data URIs
    const personUri  = personImage.startsWith('data:')  ? personImage  : `data:image/jpeg;base64,${personImage}`;
    const garmentUri = garmentImage.startsWith('data:') ? garmentImage : `data:image/jpeg;base64,${garmentImage}`;

    // Upload both images to Fal.ai storage
    const [personUrl, garmentUrl] = await Promise.all([
      uploadToFal(personUri, FAL_KEY),
      uploadToFal(garmentUri, FAL_KEY),
    ]);

    console.log('Uploaded person:', personUrl);
    console.log('Uploaded garment:', garmentUrl);

    // Call IDM-VTON — correct params per fal.ai docs
    const falRes = await fetch('https://fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        human_image_url:     personUrl,
        garment_image_url:   garmentUrl,
        description:         garmentDescription || 'stylish fashion garment',
        num_inference_steps: 30,
        seed:                Math.floor(Math.random() * 100000),
      }),
    });

    const raw = await falRes.text();
    console.log('Fal status:', falRes.status, '| body:', raw.slice(0, 400));

    if (!falRes.ok) {
      return res.status(502).json({ error: `Fal.ai ${falRes.status}`, details: raw.slice(0, 400) });
    }

    const data = JSON.parse(raw);

    // Async queue response
    if (data.request_id) {
      const imageUrl = await pollQueue(data.request_id, FAL_KEY);
      return res.status(200).json({ success: true, resultUrl: imageUrl });
    }

    // Sync response — output schema: { image: { url } }
    const imageUrl = data?.image?.url || data?.images?.[0]?.url;
    if (!imageUrl) {
      return res.status(502).json({ error: 'No image in Fal.ai response', raw: raw.slice(0, 300) });
    }

    return res.status(200).json({ success: true, resultUrl: imageUrl });

  } catch (err) {
    console.error('Tryon error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function uploadToFal(dataUri, apiKey) {
  const base64 = dataUri.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64, 'base64');

  // Primary: Fal.ai storage upload
  const res = await fetch('https://storage.googleapis.com/fal-ai-serverless-uploads/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'image/jpeg',
    },
    body: buffer,
  });

  if (res.ok) {
    const data = await res.json();
    if (data.url) return data.url;
  }

  // Fallback: Fal platform API storage
  const fallback = await fetch('https://api.fal.ai/v1/storage/upload/initiate', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_type: 'image/jpeg', file_size: buffer.length }),
  });

  if (!fallback.ok) {
    const txt = await fallback.text();
    throw new Error(`Upload failed: ${txt.slice(0, 200)}`);
  }

  const { upload_url, file_url } = await fallback.json();

  await fetch(upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer,
  });

  return file_url;
}

async function pollQueue(requestId, apiKey, max = 24) {
  const base = `https://queue.fal.run/fal-ai/idm-vton/requests/${requestId}`;
  for (let i = 0; i < max; i++) {
    await new Promise(r => setTimeout(r, 2500));
    const r = await fetch(base, { headers: { 'Authorization': `Key ${apiKey}` } });
    if (!r.ok) continue;
    const s = await r.json();
    console.log(`Poll ${i+1}:`, s.status);
    if (s.status === 'COMPLETED') {
      const rr = await fetch(`${base}/result`, { headers: { 'Authorization': `Key ${apiKey}` } });
      const result = await rr.json();
      const url = result?.image?.url || result?.images?.[0]?.url;
      if (!url) throw new Error('Completed but no URL: ' + JSON.stringify(result).slice(0, 200));
      return url;
    }
    if (s.status === 'FAILED') throw new Error('Failed: ' + JSON.stringify(s.error || s).slice(0, 200));
  }
  throw new Error('Timeout — try again');
}

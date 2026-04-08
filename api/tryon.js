// api/tryon.js
// CRIATech Virtual Try-On — Vercel Serverless Function
// Calls Fal.ai IDM-VTON model securely (API key never exposed to browser)

export const config = { maxDuration: 60 }; // 60s timeout for AI processing

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const { personImage, garmentImage, garmentDescription } = req.body;

    if (!personImage || !garmentImage) {
      return res.status(400).json({ error: 'Missing personImage or garmentImage' });
    }

    // ── STEP 1: Upload person image to Fal storage ───────────────────────────
    const personBlob = base64ToBlob(personImage);
    const personUrl  = await uploadToFal(personBlob, 'person.jpg', FAL_KEY);

    // ── STEP 2: Upload garment image to Fal storage ──────────────────────────
    const garmentBlob = base64ToBlob(garmentImage);
    const garmentUrl  = await uploadToFal(garmentBlob, 'garment.jpg', FAL_KEY);

    // ── STEP 3: Call IDM-VTON model ──────────────────────────────────────────
    // IDM-VTON: state-of-the-art virtual try-on model
    // Docs: https://fal.ai/models/fal-ai/idm-vton
    const falResponse = await fetch('https://queue.fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        human_img_url:    personUrl,
        garm_img_url:     garmentUrl,
        garment_des:      garmentDescription || 'stylish garment',
        is_checked:       true,   // use checkpointed model (better quality)
        is_checked_crop:  false,
        denoise_steps:    30,     // 20-40, higher = better quality but slower
        seed:             42,
        num_inference_steps: 30,
      }),
    });

    if (!falResponse.ok) {
      const errText = await falResponse.text();
      console.error('Fal.ai error:', errText);
      return res.status(502).json({ error: 'AI model error', details: errText });
    }

    // IDM-VTON uses async queue — poll for result
    const queueData = await falResponse.json();
    const resultUrl = await pollFalQueue(queueData.request_id, FAL_KEY);

    return res.status(200).json({
      success: true,
      resultUrl,
      requestId: queueData.request_id,
    });

  } catch (err) {
    console.error('Try-on error:', err);
    return res.status(500).json({ error: err.message });
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

function base64ToBlob(base64String) {
  // Strip data URI prefix if present
  const base64 = base64String.replace(/^data:image\/\w+;base64,/, '');
  const binary  = Buffer.from(base64, 'base64');
  return binary;
}

async function uploadToFal(buffer, filename, apiKey) {
  const formData = new FormData();
  const blob = new Blob([buffer], { type: 'image/jpeg' });
  formData.append('file', blob, filename);

  const res = await fetch('https://storage.googleapis.com/fal-ai-public-uploads/', {
    method: 'POST',
    headers: { 'Authorization': `Key ${apiKey}` },
    body: formData,
  });

  // Use Fal's storage upload endpoint
  const uploadRes = await fetch('https://fal.run/fal-ai/storage/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Key ${apiKey}`,
      'Content-Type': 'image/jpeg',
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${await uploadRes.text()}`);
  }

  const data = await uploadRes.json();
  return data.url;
}

async function pollFalQueue(requestId, apiKey, maxAttempts = 30) {
  const statusUrl = `https://queue.fal.run/fal-ai/idm-vton/requests/${requestId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2000); // poll every 2 seconds

    const statusRes = await fetch(statusUrl, {
      headers: { 'Authorization': `Key ${apiKey}` },
    });

    if (!statusRes.ok) continue;

    const status = await statusRes.json();

    if (status.status === 'COMPLETED') {
      // Get the result
      const resultRes = await fetch(`${statusUrl}/result`, {
        headers: { 'Authorization': `Key ${apiKey}` },
      });
      const result = await resultRes.json();
      return result.images?.[0]?.url || result.image?.url || result.output?.image_url;
    }

    if (status.status === 'FAILED') {
      throw new Error('AI generation failed: ' + JSON.stringify(status));
    }
    // IN_QUEUE or IN_PROGRESS — keep polling
  }

  throw new Error('Timeout: AI generation took too long');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

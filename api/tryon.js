// api/tryon.js — CRIATech Virtual Try-On
// Strategy: pass base64 data URIs directly to Fal.ai — no storage upload needed
// Fal.ai docs: "You can pass a Base64 data URI as a file input. The API will handle the file decoding for you."
// Model docs: https://fal.ai/models/fal-ai/idm-vton

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── API KEY ───────────────────────────────────────────────────────────────
  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) {
    return res.status(500).json({ error: 'API key not configured. Add FAL_API_KEY to Vercel Environment Variables.' });
  }

  // ── PARSE BODY ────────────────────────────────────────────────────────────
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid request body' });
  }

  const { personImage, garmentImage, garmentDescription } = body || {};
  if (!personImage || !garmentImage) {
    return res.status(400).json({ error: 'Missing personImage or garmentImage' });
  }

  try {
    // ── BUILD DATA URIs ───────────────────────────────────────────────────────
    // Fal.ai accepts base64 data URIs natively — no upload step needed
    const personDataUri  = personImage.startsWith('data:')
      ? personImage
      : `data:image/jpeg;base64,${personImage}`;

    const garmentDataUri = garmentImage.startsWith('data:')
      ? garmentImage
      : `data:image/jpeg;base64,${garmentImage}`;

    // ── CALL IDM-VTON ─────────────────────────────────────────────────────────
    // Correct endpoint and params per: https://fal.ai/models/fal-ai/idm-vton
    // Input schema: human_image_url, garment_image_url, description (all required)
    // The model accepts data URIs as URLs
    console.log('Calling fal.ai IDM-VTON...');

    const falRes = await fetch('https://fal.run/fal-ai/idm-vton', {
      method: 'POST',
      headers: {
        'Authorization': `Key ${FAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        human_image_url:     personDataUri,
        garment_image_url:   garmentDataUri,
        description:         garmentDescription || 'stylish fashion garment',
        num_inference_steps: 30,
        seed:                Math.floor(Math.random() * 100000),
      }),
    });

    const rawText = await falRes.text();
    console.log('Fal.ai HTTP status:', falRes.status);
    console.log('Fal.ai response (first 600 chars):', rawText.slice(0, 600));

    if (!falRes.ok) {
      return res.status(502).json({
        error: `Fal.ai returned HTTP ${falRes.status}`,
        details: rawText.slice(0, 500),
      });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: 'Fal.ai returned invalid JSON', raw: rawText.slice(0, 300) });
    }

    // ── HANDLE ASYNC QUEUE ────────────────────────────────────────────────────
    // fal.run returns synchronously but may queue — check for request_id
    if (data.request_id) {
      console.log('Job queued, request_id:', data.request_id);
      const imageUrl = await pollQueue(data.request_id, FAL_KEY);
      return res.status(200).json({ success: true, resultUrl: imageUrl });
    }

    // ── HANDLE SYNC RESPONSE ──────────────────────────────────────────────────
    // IDM-VTON output schema: { image: { url, width, height, content_type } }
    const imageUrl = data?.image?.url || data?.images?.[0]?.url;
    if (!imageUrl) {
      console.error('No image URL in response. Full data:', JSON.stringify(data).slice(0, 500));
      return res.status(502).json({
        error: 'No image URL in Fal.ai response',
        hint: 'Check Fal.ai logs in their dashboard',
        raw: JSON.stringify(data).slice(0, 300),
      });
    }

    console.log('Success! Image URL:', imageUrl);
    return res.status(200).json({ success: true, resultUrl: imageUrl });

  } catch (err) {
    console.error('Unhandled error:', err.message);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}

// ── POLL QUEUE ────────────────────────────────────────────────────────────────
async function pollQueue(requestId, apiKey, maxAttempts = 25) {
  const statusUrl = `https://queue.fal.run/fal-ai/idm-vton/requests/${requestId}`;

  for (let i = 0; i < maxAttempts; i++) {
    await sleep(2500); // Wait 2.5s between polls

    let statusData;
    try {
      const r = await fetch(statusUrl, {
        headers: { 'Authorization': `Key ${apiKey}` },
      });
      if (!r.ok) {
        console.log(`Poll ${i + 1}: HTTP ${r.status}, retrying...`);
        continue;
      }
      statusData = await r.json();
    } catch (e) {
      console.log(`Poll ${i + 1}: fetch error ${e.message}, retrying...`);
      continue;
    }

    console.log(`Poll ${i + 1}: status = ${statusData.status}`);

    if (statusData.status === 'COMPLETED') {
      // Fetch result
      const resultRes = await fetch(`${statusUrl}/result`, {
        headers: { 'Authorization': `Key ${apiKey}` },
      });
      const result = await resultRes.json();
      const url = result?.image?.url || result?.images?.[0]?.url;
      if (!url) throw new Error('Completed but no image URL: ' + JSON.stringify(result).slice(0, 200));
      return url;
    }

    if (statusData.status === 'FAILED') {
      const reason = statusData.error?.message || JSON.stringify(statusData).slice(0, 200);
      throw new Error(`Generation failed: ${reason}`);
    }

    // IN_QUEUE or IN_PROGRESS → keep polling
  }

  throw new Error('Timeout: generation took too long. Try again.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

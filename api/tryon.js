// api/tryon.js — CRIATech Virtual Try-On
// Architecture: ASYNC SUBMIT + POLL pattern
// - POST /api/tryon        → submits job to Fal.ai queue, returns request_id FAST (<3s)
// - GET  /api/tryon?id=XXX → polls status + returns result URL when ready
// This avoids Vercel's 10s timeout completely — each call is short-lived

export const config = { maxDuration: 30 }; // 30s is enough for submit+poll-check

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) {
    return res.status(500).json({ error: 'API key not configured. Add FAL_API_KEY to Vercel Environment Variables.' });
  }

  // ════════════════════════════════════════════════════════
  // GET /api/tryon?id=XXX  →  Check status / get result
  // ════════════════════════════════════════════════════════
  if (req.method === 'GET') {
    const requestId = req.query?.id;
    if (!requestId) return res.status(400).json({ error: 'Missing ?id= parameter' });

    try {
      // Check status
      const statusRes = await fetch(
        `https://queue.fal.run/fal-ai/idm-vton/requests/${requestId}/status`,
        { headers: { 'Authorization': `Key ${FAL_KEY}` } }
      );
      const statusText = await statusRes.text();
      console.log(`Status check for ${requestId}: HTTP ${statusRes.status}`, statusText.slice(0, 200));

      if (!statusRes.ok) {
        return res.status(statusRes.status).json({ error: `Status check failed: ${statusText.slice(0, 200)}` });
      }

      const statusData = JSON.parse(statusText);
      const status = statusData.status; // IN_QUEUE | IN_PROGRESS | COMPLETED | FAILED

      if (status === 'COMPLETED') {
        // Fetch actual result
        const resultRes = await fetch(
          `https://queue.fal.run/fal-ai/idm-vton/requests/${requestId}`,
          { headers: { 'Authorization': `Key ${FAL_KEY}` } }
        );
        const resultData = await resultRes.json();
        const imageUrl = resultData?.image?.url || resultData?.images?.[0]?.url;
        if (!imageUrl) {
          return res.status(502).json({ error: 'No image URL in result', raw: JSON.stringify(resultData).slice(0, 300) });
        }
        return res.status(200).json({ status: 'COMPLETED', resultUrl: imageUrl });
      }

      if (status === 'FAILED') {
        const reason = statusData.error?.message || statusData.detail || JSON.stringify(statusData).slice(0, 200);
        return res.status(200).json({ status: 'FAILED', error: reason });
      }

      // Still IN_QUEUE or IN_PROGRESS
      const queuePos = statusData.queue_position;
      return res.status(200).json({
        status,
        queuePosition: queuePos ?? null,
      });

    } catch (err) {
      console.error('Status check error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ════════════════════════════════════════════════════════
  // POST /api/tryon  →  Submit job to Fal.ai queue
  // Returns request_id immediately (< 3 seconds)
  // ════════════════════════════════════════════════════════
  if (req.method === 'POST') {
    let body;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const { personImage, garmentImage, garmentDescription } = body || {};
    if (!personImage || !garmentImage) {
      return res.status(400).json({ error: 'Missing personImage or garmentImage' });
    }

    // Build data URIs — Fal.ai accepts base64 directly
    const personDataUri  = personImage.startsWith('data:')  ? personImage  : `data:image/jpeg;base64,${personImage}`;
    const garmentDataUri = garmentImage.startsWith('data:') ? garmentImage : `data:image/jpeg;base64,${garmentImage}`;

    try {
      // Submit to async queue — returns immediately with request_id
      const submitRes = await fetch('https://queue.fal.run/fal-ai/idm-vton', {
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

      const submitText = await submitRes.text();
      console.log(`Submit HTTP ${submitRes.status}:`, submitText.slice(0, 300));

      if (!submitRes.ok) {
        return res.status(502).json({
          error: `Fal.ai submit failed (HTTP ${submitRes.status})`,
          details: submitText.slice(0, 400),
        });
      }

      const submitData = JSON.parse(submitText);

      if (!submitData.request_id) {
        // Fal.ai returned synchronous result (unlikely but handle it)
        const imageUrl = submitData?.image?.url || submitData?.images?.[0]?.url;
        if (imageUrl) {
          return res.status(200).json({ status: 'COMPLETED', resultUrl: imageUrl });
        }
        return res.status(502).json({ error: 'No request_id or image in response', raw: submitText.slice(0, 300) });
      }

      // Return request_id to frontend for polling
      return res.status(200).json({
        status: 'SUBMITTED',
        requestId: submitData.request_id,
        queuePosition: submitData.queue_position ?? null,
      });

    } catch (err) {
      console.error('Submit error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

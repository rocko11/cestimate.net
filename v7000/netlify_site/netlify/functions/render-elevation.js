// netlify/functions/render-elevation.js
// Photoreal rendering that FOLLOWS the drawn elevation: the elevation sheet's line drawing is the
// control image for FLUX.1 Canny [pro] (Black Forest Labs, hosted on Replicate). Geometry —
// floors, window grid, setbacks, storefront — comes from the drawing; the prompt only sets
// materials, light and street context.
// Setup: Netlify > Site settings > Environment variables > REPLICATE_API_TOKEN.
// POST {image:"data:image/jpeg;base64,...", prompt}  -> {id}
// GET  ?id=<prediction id>                            -> {status, image?:url, error?}
const MODEL = 'black-forest-labs/flux-canny-pro';
const API = 'https://api.replicate.com/v1';
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async (event) => {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(501, { error: 'REPLICATE_API_TOKEN is not configured on the server' });
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  try {
    if (event.httpMethod === 'GET') {
      const id = (event.queryStringParameters || {}).id;
      if (!id || !/^[a-z0-9]+$/i.test(id)) return json(400, { error: 'bad id' });
      const r = await fetch(API + '/predictions/' + id, { headers: auth });
      const d = await r.json();
      if (!r.ok) return json(r.status, { error: d.detail || 'replicate error' });
      const out = Array.isArray(d.output) ? d.output[0] : d.output;
      return json(200, { status: d.status, image: d.status === 'succeeded' ? out : null, error: d.error || null });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    const { image, prompt } = JSON.parse(event.body || '{}');
    if (typeof image !== 'string' || !image.startsWith('data:image/')) return json(400, { error: 'image (data URL) required' });
    if (image.length > 4.5e6) return json(413, { error: 'image too large' });
    const r = await fetch(API + '/models/' + MODEL + '/predictions', {
      method: 'POST', headers: auth,
      body: JSON.stringify({ input: {
        control_image: image,
        prompt: String(prompt || '').slice(0, 1800),
        steps: 40, guidance: 25, output_format: 'jpg', safety_tolerance: 2, prompt_upsampling: false,
      } }),
    });
    const d = await r.json();
    if (!r.ok) return json(r.status, { error: d.detail || d.title || 'replicate error' });
    return json(200, { id: d.id, status: d.status });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};

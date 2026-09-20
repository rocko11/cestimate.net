// netlify/functions/render-facade.js
// Generates a photorealistic exterior facade rendering from a text prompt
// built client-side from the takeoff's building metrics.
//
// Setup: in Netlify site settings > Environment variables, add OPENAI_API_KEY
// with a valid OpenAI API key (needs image-generation access).

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let prompt, referenceImage;
  try {
    ({ prompt, referenceImage } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing prompt' }) };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'OPENAI_API_KEY is not configured on the server' }) };
  }

  // If a reference image (data URL, e.g. from an uploaded elevation sheet) is
  // supplied, use the edits endpoint so the rendering follows its massing and
  // fenestration; otherwise fall back to plain text-to-image generation.
  const hasReference = typeof referenceImage === 'string' && referenceImage.startsWith('data:image');
  const endpoint = hasReference
    ? 'https://api.openai.com/v1/images/edits'
    : 'https://api.openai.com/v1/images/generations';
  const payload = hasReference
    ? { model: 'gpt-image-1', prompt: prompt.slice(0, 4000), images: [{ image_url: referenceImage }], size: '1536x1024', quality: 'high', n: 1 }
    : { model: 'gpt-image-1', prompt: prompt.slice(0, 4000), size: '1536x1024', quality: 'high', n: 1 };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json();
    if (!resp.ok) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({ error: (data.error && data.error.message) || 'Image generation failed' }),
      };
    }

    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No image returned by provider' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ image: b64 }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

const { requireUser, unauthorized } = require('../lib/auth');
// netlify/functions/streetview.js
// Google Street View photo of the project address, used as the real street the new building is placed into.
// Setup: Google Cloud > enable "Street View Static API" > create an API key, then
// Netlify > Site settings > Environment variables > GOOGLE_MAPS_API_KEY.
// GET ?address=915 Dean St, Brooklyn, NY[&pitch=18&fov=90] -> {image:"data:image/jpeg;base64,...", date, pano}
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
exports.handler = async (event) => {
  // Signed-in, approved accounts only (these calls cost money).
  if (event.httpMethod !== 'OPTIONS' && !(await requireUser(event))) return unauthorized();
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return json(501, { error: 'GOOGLE_MAPS_API_KEY is not configured on the server' });
  const q = event.queryStringParameters || {};
  const address = String(q.address || '').trim().slice(0, 200);
  if (address.length < 5) return json(400, { error: 'address required' });
  const pitch = Math.max(-10, Math.min(45, Number(q.pitch) || 18));
  const fov = Math.max(40, Math.min(120, Number(q.fov) || 90));
  try {
    const base = 'https://maps.googleapis.com/maps/api/streetview';
    const loc = encodeURIComponent(address);
    // Metadata is free and tells us whether imagery exists before we pay for an image.
    const meta = await (await fetch(`${base}/metadata?location=${loc}&source=outdoor&key=${key}`)).json();
    if (meta.status !== 'OK') return json(404, { error: 'No Street View imagery for this address (' + meta.status + ')' });
    // No heading given: Google points the camera from the nearest panorama at the address itself.
    const r = await fetch(`${base}?size=640x640&location=${loc}&fov=${fov}&pitch=${pitch}&source=outdoor&return_error_code=true&key=${key}`);
    if (!r.ok) return json(r.status, { error: 'Street View image error ' + r.status });
    const b = Buffer.from(await r.arrayBuffer());
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=86400' },
      body: JSON.stringify({ image: 'data:image/jpeg;base64,' + b.toString('base64'), date: meta.date || null, pano: meta.pano_id || null, location: meta.location || null }) };
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
};

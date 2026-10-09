// Live material-pricing proxy for the Plan Takeoff Estimator.
// Keeps third-party calls server-side (no CORS issues, one place to cache).
// No API key needed. PPI escalation is handled separately by ppi.js. Copy next to analyze.js and redeploy.
//
//   GET /.netlify/functions/prices?source=ep&trade=concrete&zip=11249
//       EstimationPro Cost API items for a trade, regionally adjusted to a ZIP.
//   GET /.netlify/functions/prices?source=ep-trades
//       EstimationPro trade list.
//
// Source:   https://estimationpro.ai/api/v1  (free, attribution required; 100 req/day per IP)


const cache = new Map();
function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.val);
  return fn().then(val => { cache.set(key, { val, exp: Date.now() + ttlMs }); return val; });
}
const json = (status, body) => ({ statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });


async function fetchEP(path) {
  const r = await fetch('https://estimationpro.ai/api/v1' + path, { headers: { 'Accept': 'application/json', 'User-Agent': 'PNG-Plan-Takeoff-Estimator/1.0' } });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch (e) { throw new Error('EstimationPro returned non-JSON (' + r.status + ')'); }
  if (!r.ok) throw new Error('EstimationPro: ' + (d.error || ('HTTP ' + r.status)));
  return d;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  try {
    if (q.source === 'ep-trades') return json(200, await cached('ep:trades', 24 * 3600e3, () => fetchEP('/trades')));
    if (q.source === 'ep') {
      const trade = String(q.trade || '').replace(/[^a-z0-9-]/gi, '').toLowerCase(); if (!trade) return json(400, { error: 'trade required' });
      const zip = /^\d{5}$/.test(q.zip || '') ? q.zip : '';
      return json(200, await cached('ep:' + trade + ':' + zip, 24 * 3600e3, () => fetchEP('/costs?trade=' + encodeURIComponent(trade) + (zip ? '&zip=' + zip : ''))));
    }
    return json(400, { error: 'unknown source; use ep or ep-trades' });
  } catch (e) {
    return json(502, { error: String(e && e.message || e) });
  }
};

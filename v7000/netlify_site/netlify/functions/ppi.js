// netlify/functions/ppi.js
// Open-data material price indexes: U.S. Bureau of Labor Statistics Producer Price Index (PPI).
// Returns, for each series, the latest monthly value and the value in the base month the app's
// unit prices were set (BASE = 2025-06). The browser turns that into a % change per trade.
// No key needed (BLS v2 allows ~25 unkeyed requests/day); set BLS_API_KEY for 500/day.
// Responses are CDN-cached for 12 hours, so normal use stays far below the limit.
const SERIES = {
  WPU1333: 'Ready-mix concrete',
  WPU1017: 'Steel mill products',
  WPU1074: 'Structural & architectural metal products',
  WPU0811: 'Softwood lumber',
  WPU137: 'Gypsum products',
  WPU1392: 'Insulation materials',
  WPU1361: 'Asphalt roofing products',
  WPU1342: 'Brick & structural clay tile',
  WPU105: 'Plumbing fixtures & fittings',
  WPU10260314: 'Copper wire & cable',
  WPU1148: 'Air-conditioning & refrigeration equipment',
  WPUIP2311001: 'Inputs to residential construction, goods',
  WPUIP2300001: 'Inputs to construction industries, goods',
};
const BASE = { year: '2025', period: 'M06' };
let memo = null;

exports.handler = async () => {
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
    'Netlify-CDN-Cache-Control': 'public, durable, max-age=43200, stale-while-revalidate=86400',
  };
  if (memo && Date.now() - memo.t < 6 * 3600e3) return { statusCode: 200, headers, body: memo.body };
  try {
    const now = new Date();
    const body = { seriesid: Object.keys(SERIES), startyear: BASE.year, endyear: String(now.getUTCFullYear()) };
    if (process.env.BLS_API_KEY) body.registrationkey = process.env.BLS_API_KEY;
    const r = await fetch('https://api.bls.gov/publicAPI/v2/timeseries/data/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.status !== 'REQUEST_SUCCEEDED') throw new Error((j.message || []).join(' ') || 'BLS request failed');
    const out = {};
    (j.Results.series || []).forEach((s) => {
      const data = (s.data || []).filter((p) => /^M(0[1-9]|1[0-2])$/.test(p.period) && !isNaN(parseFloat(p.value)));
      if (!data.length) return;
      const latest = data[0];   // BLS returns newest first
      const base = data.find((p) => p.year === BASE.year && p.period === BASE.period) || data[data.length - 1];
      out[s.seriesID] = {
        name: SERIES[s.seriesID],
        latest: { year: latest.year, period: latest.period, value: parseFloat(latest.value) },
        base: { year: base.year, period: base.period, value: parseFloat(base.value) },
        change: parseFloat(latest.value) / parseFloat(base.value) - 1,
      };
    });
    const res = JSON.stringify({ source: 'U.S. Bureau of Labor Statistics, Producer Price Index (not seasonally adjusted)', base: BASE, fetched: now.toISOString(), series: out });
    memo = { t: Date.now(), body: res };
    return { statusCode: 200, headers, body: res };
  } catch (e) {
    return { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};

const { requireUser, unauthorized } = require('../lib/auth');
// Comparable sales + land value for the appraisal, from NYC Open Data (no key needed):
//   PLUTO (64uk-42ks)                  — subject address → BBL, lat/lon, lot area, FAR, year built
//   Rolling Calendar Sales (usep-8jbt) — recorded sales: price, GSF, units, date (building and vacant-land sales)
// POST {address, borough?, gfa?, units?, months?} → {subject, comps:[…], land:{…}}
const FN_VERSION = '2026-10-19b';
const PLUTO = 'https://data.cityofnewyork.us/resource/64uk-42ks.json';
const SALES = 'https://data.cityofnewyork.us/resource/usep-8jbt.json';
const BORO = { 1:'MN', 2:'BX', 3:'BK', 4:'QN', 5:'SI' };
const BORO_NAME = { 1:'MANHATTAN', 2:'BRONX', 3:'BROOKLYN', 4:'QUEENS', 5:'STATEN ISLAND' };
const SUFFIX = { ST:'STREET', 'ST.':'STREET', AVE:'AVENUE', 'AVE.':'AVENUE', AV:'AVENUE', BLVD:'BOULEVARD', PL:'PLACE', RD:'ROAD', DR:'DRIVE',
  PKWY:'PARKWAY', LN:'LANE', CT:'COURT', TER:'TERRACE', EXPY:'EXPRESSWAY', HWY:'HIGHWAY', E:'EAST', W:'WEST', N:'NORTH', S:'SOUTH', SQ:'SQUARE' };
// Residential income-property classes we compare against (3-family, rentals, walk-ups, elevator, condo/coop buildings, mixed-use).
const RESI_CATS = ['03','07','08','09','10','11','12','13','14','15','16','17','22'];
// Vacant land classes for the land-value indication.
const LAND_CATS = ['05','31','46'];

const json = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function q(url, params) {
  const r = await fetch(url + '?' + new URLSearchParams(params).toString(), { headers: { accept: 'application/json' } });
  const d = await r.json();
  if (!r.ok || (d && d.error)) throw new Error('NYC Open Data: ' + ((d && d.message) || r.status));
  return Array.isArray(d) ? d : [];
}
const sq = s => String(s).replace(/'/g, "''");
const orList = (field, vals) => '(' + vals.map(v => `${field}='${sq(v)}'`).join(' OR ') + ')';
const catList = cats => '(' + cats.map(c => `building_class_category like '${c}%'`).join(' OR ') + ')';
const median = a => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

function normAddress(a) {
  let s = String(a || '').toUpperCase().replace(/[,#].*$/, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(BROOKLYN|MANHATTAN|BRONX|QUEENS|STATEN ISLAND|NEW YORK|NY)\b.*$/, '').trim();
  s = s.replace(/\b(\d+)(ST|ND|RD|TH)\b/g, '$1');
  return s.split(' ').map((w, i) => (i > 0 && SUFFIX[w]) ? SUFFIX[w] : w).join(' ');
}
function guessBoro(a) {
  const s = String(a || '').toUpperCase();
  if (/BROOKLYN|\b112\d\d\b/.test(s)) return 3; if (/BRONX|\b104\d\d\b/.test(s)) return 2;
  if (/QUEENS|\b11[3-6]\d\d\b/.test(s)) return 4; if (/STATEN|\b103\d\d\b/.test(s)) return 5;
  if (/MANHATTAN|NEW YORK, NY|\b100\d\d\b/.test(s)) return 1; return 0;
}
const dist = (a, b, c, d) => { const R = 3958.8, toR = x => x * Math.PI / 180; const dLa = toR(c - a), dLo = toR(d - b);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') return json(200, { ok: true, version: FN_VERSION });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  if (!(await requireUser(event))) return unauthorized();
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const addr = normAddress(body.address);
  if (!addr) return json(400, { error: 'Missing address' });
  const boro = +body.borough || guessBoro(body.address) || 3;
  const months = Math.min(60, Math.max(6, +body.months || 36));
  const gfa = +body.gfa || 0, units = +body.units || 0;
  try {
    // 1) Subject lot
    const sel = 'borough,block,lot,bbl,address,zipcode,latitude,longitude,lotarea,bldgarea,bldgclass,yearbuilt,unitsres,unitstotal,numfloors,zonedist1,residfar,commfar,facilfar,landuse';
    let rows = await q(PLUTO, { $select: sel, $where: `borough='${BORO[boro]}' AND upper(address)='${sq(addr)}'`, $limit: 1 });
    if (!rows.length) {
      const parts = addr.split(' ');
      rows = await q(PLUTO, { $select: sel, $where: `borough='${BORO[boro]}' AND upper(address) like '${sq(parts[0] + ' ' + (parts[1] || ''))}%'`, $limit: 1 });
    }
    if (!rows.length) return json(404, { error: `Address "${addr}" not found in NYC PLUTO for ${BORO_NAME[boro]}. Check the spelling / borough.` });
    const s = rows[0];
    const maxFar = Math.max(+s.residfar || 0, +s.commfar || 0, +s.facilfar || 0);
    const subject = { address: s.address, bbl: s.bbl, block: +s.block, lot: +s.lot, zip: s.zipcode, lat: +s.latitude, lon: +s.longitude,
      lotSF: +s.lotarea || 0, bldgSF: +s.bldgarea || 0, bldgClass: s.bldgclass, yearBuilt: +s.yearbuilt || 0, unitsRes: +s.unitsres || 0,
      floors: +s.numfloors || 0, zoning: s.zonedist1, residFar: +s.residfar || 0, maxFar, buildableSF: Math.round((+s.lotarea || 0) * maxFar) };

    // 2) Candidate sales: same borough, nearby zip codes, real prices, recent. Buildings and vacant land in one pull each.
    const since = new Date(); since.setMonth(since.getMonth() - months);
    const zips = [s.zipcode].concat([-1, 1, -2, 2].map(d => String(+s.zipcode + d))).filter(z => /^\d{5}$/.test(z));
    const base = `borough='${boro}' AND ${orList('zip_code', zips)} AND sale_price>250000 AND sale_date>='${since.toISOString().slice(0, 10)}'`;
    const fields = 'address,apartment_number,zip_code,block,lot,neighborhood,building_class_category,building_class_at_time_of,residential_units,commercial_units,total_units,gross_square_feet,land_square_feet,year_built,sale_price,sale_date';
    const [bld, lnd] = await Promise.all([
      q(SALES, { $select: fields, $where: `${base} AND gross_square_feet>0 AND ${catList(RESI_CATS)}`, $order: 'sale_date DESC', $limit: 400 }),
      q(SALES, { $select: fields, $where: `${base} AND ${catList(LAND_CATS)}`, $order: 'sale_date DESC', $limit: 200 }),
    ]);
    const notSubject = r => !String(r.apartment_number || '').trim() && !(+r.block === subject.block && +r.lot === subject.lot);
    const sales = bld.filter(notSubject), landSales = lnd.filter(notSubject);

    // 3) Locate every candidate lot in one PLUTO query (lat/lon, lot area, FAR) and score.
    const keys = [...new Set(sales.concat(landSales).map(r => `${+r.block}-${+r.lot}`))].slice(0, 220);
    const loc = {};
    for (let i = 0; i < keys.length; i += 110) {
      const chunk = keys.slice(i, i + 110);
      const w = `borough='${BORO[boro]}' AND (` + chunk.map(k => { const [b, l] = k.split('-'); return `(block=${+b} AND lot=${+l})`; }).join(' OR ') + ')';
      const pl = await q(PLUTO, { $select: 'block,lot,latitude,longitude,numfloors,bldgarea,lotarea,residfar,commfar,facilfar,zonedist1', $where: w, $limit: 300 });
      pl.forEach(p => { loc[`${+p.block}-${+p.lot}`] = p; });
    }
    const now = Date.now();
    const common = r => {
      const p = loc[`${+r.block}-${+r.lot}`] || {};
      const d = (p.latitude && subject.lat) ? dist(subject.lat, subject.lon, +p.latitude, +p.longitude) : 9;
      const ageMo = (now - new Date(r.sale_date).getTime()) / 2.63e9;
      return { p, d, ageMo, timeAdj: ageMo / 12 * 3 };   // market time: +3%/yr since the sale
    };

    // Building comps
    const scored = sales.map(r => {
      const { p, d, ageMo, timeAdj } = common(r);
      const gsf = +r.gross_square_feet || 0, u = +r.residential_units || +r.total_units || 0, price = +r.sale_price;
      const sizeRatio = gfa > 0 && gsf > 0 ? Math.max(gsf, gfa) / Math.min(gsf, gfa) : 1.5;
      const unitRatio = units > 0 && u > 0 ? Math.max(u, units) / Math.min(u, units) : 1.5;
      const score = d * 2 + (sizeRatio - 1) * 3 + (unitRatio - 1) * 1.5 + ageMo / 12;
      const sizeAdj = gfa > 0 && gsf > 0 ? Math.max(-10, Math.min(10, Math.log(gsf / gfa) * 8)) : 0;   // bigger buildings trade lower per SF
      return { address: r.address, zip: r.zip_code, neighborhood: r.neighborhood, category: r.building_class_category, bldgClass: r.building_class_at_time_of,
        date: String(r.sale_date).slice(0, 10), price, gsf, units: u, yearBuilt: +r.year_built || 0, floors: +p.numfloors || 0,
        distanceMi: +d.toFixed(2), psf: gsf ? Math.round(price / gsf) : 0, pricePerUnit: u ? Math.round(price / u) : 0,
        suggestedAdj: +(timeAdj + sizeAdj).toFixed(1), score };
    }).sort((a, b) => a.score - b.score);
    const comps = scored.filter(c => c.psf > 50 && c.psf < 3000).slice(0, +body.limit || 12);

    // Land comps → $/lot SF and $/buildable SF (price ÷ lot × max FAR), time-adjusted to today.
    const landScored = landSales.map(r => {
      const { p, d, ageMo, timeAdj } = common(r);
      const lotSF = +String(r.land_square_feet || '').replace(/[^0-9.]/g, '') || +p.lotarea || 0;
      const far = Math.max(+p.residfar || 0, +p.commfar || 0, +p.facilfar || 0);
      const price = +r.sale_price, adjPrice = price * (1 + timeAdj / 100);
      return { address: r.address, zip: r.zip_code, neighborhood: r.neighborhood, category: r.building_class_category, date: String(r.sale_date).slice(0, 10),
        price, lotSF, zoning: p.zonedist1 || '', far, buildableSF: Math.round(lotSF * far), distanceMi: +d.toFixed(2), timeAdj: +timeAdj.toFixed(1),
        psfLot: lotSF ? Math.round(adjPrice / lotSF) : 0, psfBuildable: lotSF && far ? Math.round(adjPrice / (lotSF * far)) : 0, score: d * 2 + ageMo / 12 + (far && Math.abs(far - maxFar) > 1.5 ? 2 : 0) };
    }).filter(c => c.lotSF > 500 && c.psfLot > 20 && c.psfLot < 5000).sort((a, b) => a.score - b.score).slice(0, 10);
    const bsf = landScored.filter(c => c.psfBuildable > 0).map(c => c.psfBuildable), lsf = landScored.map(c => c.psfLot);
    const medBSF = median(bsf), medLSF = median(lsf);
    const byBuildable = subject.buildableSF > 0 ? medBSF * subject.buildableSF : 0, byLot = medLSF * subject.lotSF;
    const land = { comps: landScored, medianPsfBuildable: Math.round(medBSF), medianPsfLot: Math.round(medLSF), byBuildable: Math.round(byBuildable), byLot: Math.round(byLot),
      value: Math.round(byBuildable > 0 ? (byLot > 0 ? byBuildable * 0.7 + byLot * 0.3 : byBuildable) : byLot),
      method: byBuildable > 0 ? 'Median time-adjusted $/buildable SF of nearby vacant-land sales × subject lot × max FAR (70%), cross-checked by $/lot SF (30%)' : 'Median time-adjusted $/lot SF of nearby vacant-land sales × subject lot area' };

    return json(200, { version: FN_VERSION, subject, months, zips, candidates: { buildings: sales.length, land: landSales.length }, comps, land });
  } catch (e) {
    return json(500, { error: 'Comp search failed: ' + ((e && e.message) || e) });
  }
};

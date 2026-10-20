// netlify/lib/nj.js — New Jersey subject lot + comparable sales + land value (no API key needed).
// Sources (State of New Jersey, NJ Office of GIS / Division of Taxation):
//   NJ Geocoder (NJOGIS composite locator)  — address → lat/lon
//   Parcels & MOD-IV Composite of NJ        — every tax parcel with the MOD-IV assessment list: class, lot acreage,
//                                             building description, year built, dwellings, assessed land/improvement,
//                                             and the last recorded deed sale (SR-1A: date, price, non-usable code).
// Returns the same shape comps.js returns for NYC, so the appraisal screen works unchanged.
const GEOCODE = 'https://geo.nj.gov/arcgis/rest/services/Tasks/NJ_Geocode/GeocodeServer/findAddressCandidates';
const PARCELS = 'https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query';
const SOURCE = 'NJ MOD-IV tax list & SR-1A deed sales (NJOGIS Parcels Composite)';

const NJ_CITY = /,\s*(JERSEY CITY|HOBOKEN|NEWARK|BAYONNE|UNION CITY|WEEHAWKEN|WEST NEW YORK|NORTH BERGEN|SECAUCUS|KEARNY|HARRISON|GUTTENBERG|ELIZABETH|PATERSON|PASSAIC|CLIFTON|HACKENSACK|FORT LEE|EDGEWATER|CLIFFSIDE PARK|ENGLEWOOD|TEANECK|PALISADES PARK|RIDGEFIELD|MONTCLAIR|EAST ORANGE|WEST ORANGE|SOUTH ORANGE|IRVINGTON|BLOOMFIELD|BELLEVILLE|NUTLEY|LINDEN|RAHWAY|PLAINFIELD|PERTH AMBOY|NEW BRUNSWICK|EDISON|WOODBRIDGE|ASBURY PARK|LONG BRANCH|RED BANK|TRENTON|CAMDEN|PRINCETON|MORRISTOWN|LAKEWOOD|TOMS RIVER|ATLANTIC CITY|HOBOKEN)\b/;
// NJ if the address says so (state / NJ zip), or names an NJ city after a comma and no NY marker.
function isNJ(address, hint) {
  const s = String(address || '').toUpperCase();
  if (/\bNJ\b|NEW JERSEY/.test(s) || /\b0[78]\d{3}\b/.test(s)) return true;
  if (/\bNY\b|NEW YORK|BROOKLYN|MANHATTAN|BRONX|QUEENS|STATEN ISLAND|\b1[01]\d{3}\b/.test(s)) return false;
  if (NJ_CITY.test(s)) return true;
  return String(hint || '').toUpperCase() === 'NJ';
}

async function getJSON(url, params) {
  const r = await fetch(url + '?' + new URLSearchParams(params).toString(), { headers: { accept: 'application/json' } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('NJ GIS: ' + ((d.error && (d.error.message || JSON.stringify(d.error))) || r.status));
  return d;
}
const median = a => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const dist = (a, b, c, d) => { const R = 3958.8, t = x => x * Math.PI / 180; const h = Math.sin(t(c - a) / 2) ** 2 + Math.cos(t(a)) * Math.cos(t(c)) * Math.sin(t(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
const yymmdd = dt => dt.toISOString().slice(2, 10).replace(/-/g, '');
// Lot area: CALC_ACRE when the county filled it, else the parcel polygon (Web Mercator m² × cos²(lat) → true m² → SF).
const lotArea = (a, lat) => Math.round((+a.CALC_ACRE || 0) > 0 ? +a.CALC_ACRE * 43560 : (+a.Shape__Area || 0) * Math.cos(lat * Math.PI / 180) ** 2 * 10.7639);
const deedISO = s => (/^\d{6}$/.test(String(s || '')) ? '20' + s.slice(0, 2) + '-' + s.slice(2, 4) + '-' + s.slice(4, 6) : '');
// MOD-IV building description, e.g. "3S-B-C-4U-NH", "140APT 137242SF", "79S-781U-C-609P"
function parseDesc(desc) {
  const s = String(desc || '').toUpperCase();
  const st = s.match(/(?:^|[^0-9])(\d{1,3})(?:\.\d)?S\b/), u = s.match(/(\d{1,4})\s*(?:U|APT|APTS|UNITS?)\b/), sf = s.match(/(\d{3,7})\s*SF\b/);
  return { stories: st ? +st[1] : 0, units: u ? +u[1] : 0, sf: sf ? +sf[1] : 0, condo: /CONDO/.test(s) };
}
const CLASS_NAME = { '1': 'Vacant land', '2': 'Residential (1–4 family)', '4A': 'Commercial', '4B': 'Industrial', '4C': 'Apartment (5+ units)', '15C': 'Public property', '15D': 'Charitable/exempt' };

async function njComps(body) {
  const months = Math.min(60, Math.max(6, +body.months || 36));
  const gfa = +body.gfa || 0, units = +body.units || 0;
  // 1) Address → point
  let single = String(body.address || '').trim();
  if (!/\bNJ\b|NEW JERSEY/i.test(single)) single += ', NJ';
  const g = await getJSON(GEOCODE, { SingleLine: single, outSR: 4326, maxLocations: 3, f: 'json' });
  const cand = (g.candidates || []).filter(c => c.score >= 80)[0];
  if (!cand) throw Object.assign(new Error(`Address "${body.address}" was not found by the New Jersey geocoder. Include the town, e.g. "30 Montgomery St, Jersey City, NJ".`), { code: 404 });
  const lon = cand.location.x, lat = cand.location.y, zip = (String(cand.address).match(/\b(0[78]\d{3})\b/) || [])[1] || '';
  const pt = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const base = { geometry: pt, geometryType: 'esriGeometryPoint', inSR: 4326, spatialRel: 'esriSpatialRelIntersects', returnGeometry: false, f: 'json' };

  // 2) Subject parcel (the geocoded point sometimes falls on the street — widen to 25 m and take the nearest).
  const sf = 'PAMS_PIN,PCLBLOCK,PCLLOT,PROP_CLASS,COUNTY,MUN_NAME,PROP_LOC,LAND_VAL,IMPRVT_VAL,NET_VALUE,BLDG_DESC,LAND_DESC,CALC_ACRE,DEED_DATE,SALE_PRICE,YR_CONSTR,DWELL,COMM_DWELL,Shape__Area';
  let sp = await getJSON(PARCELS, Object.assign({}, base, { outFields: sf }));
  if (!(sp.features || []).length) sp = await getJSON(PARCELS, Object.assign({}, base, { outFields: sf, distance: 25, units: 'esriSRUnit_Meter', returnCentroid: true, outSR: 4326 }));
  const feats = sp.features || [];
  if (!feats.length) throw Object.assign(new Error('No New Jersey tax parcel found at ' + cand.address), { code: 404 });
  const num = (String(body.address).match(/^\s*(\d+)/) || [])[1];
  const S = (feats.find(f => num && String(f.attributes.PROP_LOC || '').startsWith(num + ' ')) || feats[0]).attributes;
  const sd = parseDesc(S.BLDG_DESC);
  const lotSF = lotArea(S, lat);
  const subject = {
    address: cand.address, bbl: S.PAMS_PIN, block: S.PCLBLOCK, lot: S.PCLLOT, zip, lat, lon, lotSF, bldgSF: sd.sf || 0,
    bldgClass: S.PROP_CLASS + (CLASS_NAME[S.PROP_CLASS] ? ' · ' + CLASS_NAME[S.PROP_CLASS] : '') + (S.BLDG_DESC ? ' · ' + S.BLDG_DESC : ''),
    yearBuilt: +S.YR_CONSTR || 0, unitsRes: +S.DWELL || +S.COMM_DWELL || sd.units || 0, floors: sd.stories || 0,
    zoning: '', residFar: 0, maxFar: 0, buildableSF: 0,
    municipality: S.MUN_NAME, county: S.COUNTY, state: 'NJ',
    assessedLand: +S.LAND_VAL || 0, assessedImprovement: +S.IMPRVT_VAL || 0, assessedTotal: +S.NET_VALUE || 0,
    lastSale: S.SALE_PRICE > 0 ? { date: deedISO(S.DEED_DATE), price: +S.SALE_PRICE } : null,
  };

  // 3) Recorded arm's-length sales nearby (blank SR-1A non-usable code), widening the radius until there are enough.
  const since = new Date(); since.setMonth(since.getMonth() - months);
  const where = `DEED_DATE>='${yymmdd(since)}' AND DEED_DATE<='${yymmdd(new Date())}' AND SALE_PRICE>100000 AND PROP_CLASS IN ('1','2','4A','4C')`;
  const of = 'PAMS_PIN,PROP_CLASS,PROP_LOC,MUN_NAME,BLDG_DESC,CALC_ACRE,DEED_DATE,SALE_PRICE,SALES_CODE,YR_CONSTR,DWELL,COMM_DWELL,Shape__Area';
  let rows = [], radiusM = 0;
  for (const r of [1200, 2400, 4000]) {
    radiusM = r;
    const d = await getJSON(PARCELS, Object.assign({}, base, { where, outFields: of, distance: r, units: 'esriSRUnit_Meter', returnCentroid: true, outSR: 4326, resultRecordCount: 2000, orderByFields: 'DEED_DATE DESC' }));
    // SR-1A non-usable deed codes are numeric (0–33: family transfers, foreclosures, partial interests…) → drop.
    // Letter codes some counties use (e.g. "A") are kept; price outliers are screened below.
    rows = (d.features || []).filter(f => f.attributes.PAMS_PIN !== S.PAMS_PIN && !/^\s*\d/.test(String(f.attributes.SALES_CODE || '')));
    // Several sales on one street address in the window = condo units / parking spaces on a shared lot, not whole-property sales.
    const seen = {}; rows.forEach(f => { const k = String(f.attributes.PROP_LOC || '').replace(/[.\s]+/g, ' ').trim(); seen[k] = (seen[k] || 0) + 1; });
    rows = rows.filter(f => seen[String(f.attributes.PROP_LOC || '').replace(/[.\s]+/g, ' ').trim()] === 1);
    const bldgs = rows.filter(f => f.attributes.PROP_CLASS !== '1').length;
    if (bldgs >= 25 && rows.length - bldgs >= 4) break;
  }
  const now = Date.now();
  const enrich = f => {
    const a = f.attributes, c = f.centroid || {}, d = parseDesc(a.BLDG_DESC);
    const date = deedISO(a.DEED_DATE), ageMo = date ? (now - new Date(date).getTime()) / 2.63e9 : 24;
    return { a, d, date, ageMo, timeAdj: ageMo / 12 * 3, distanceMi: c.y ? dist(lat, lon, c.y, c.x) : 9, lotSF: lotArea(a, lat) };
  };

  // Building comps: 1–4 family, apartments, mixed-use. Skip condo-unit sales (unit price on a big building's record).
  const bld = rows.filter(f => f.attributes.PROP_CLASS !== '1').map(enrich).filter(x => {
    const u = +x.a.DWELL || +x.a.COMM_DWELL || x.d.units;
    if (x.d.condo || x.lotSF <= 0) return false;
    if (x.a.PROP_CLASS === '2' && x.d.units > 4) return false;
    return x.a.PROP_CLASS !== '4A' || u > 0;            // commercial only when it has apartments (mixed-use)
  });
  const compsAll = bld.map(x => {
    const u = +x.a.DWELL || +x.a.COMM_DWELL || x.d.units || (x.a.PROP_CLASS === '2' ? 1 : 0), gsf = x.d.sf || 0, price = +x.a.SALE_PRICE;
    const unitRatio = units > 0 && u > 0 ? Math.max(u, units) / Math.min(u, units) : 1.5;
    const sizeRatio = gfa > 0 && gsf > 0 ? Math.max(gsf, gfa) / Math.min(gsf, gfa) : unitRatio;
    const sizeAdj = gfa > 0 && gsf > 0 ? Math.max(-10, Math.min(10, Math.log(gsf / gfa) * 8)) : 0;
    return { address: x.a.PROP_LOC + ', ' + x.a.MUN_NAME, zip: '', neighborhood: x.a.MUN_NAME, category: CLASS_NAME[x.a.PROP_CLASS] || x.a.PROP_CLASS,
      bldgClass: x.a.BLDG_DESC || '', date: x.date, price, gsf, units: u, yearBuilt: +x.a.YR_CONSTR || 0, floors: x.d.stories || 0,
      distanceMi: +x.distanceMi.toFixed(2), psf: gsf ? Math.round(price / gsf) : 0, pricePerUnit: u ? Math.round(price / u) : 0,
      suggestedAdj: +(x.timeAdj + sizeAdj).toFixed(1), score: x.distanceMi * 2 + (sizeRatio - 1) * 3 + (unitRatio - 1) * 1.5 + x.ageMo / 12 };
  }).filter(c => c.pricePerUnit > 25000 || c.psf > 50);
  // Screen price outliers (partial interests, bulk/portfolio deeds) against the local median $/unit.
  const medPU = median(compsAll.map(c => c.pricePerUnit).filter(Boolean));
  const comps = compsAll.filter(c => !medPU || !c.pricePerUnit || (c.pricePerUnit > medPU * 0.35 && c.pricePerUnit < medPU * 3))
    .sort((a, b) => a.score - b.score).slice(0, +body.limit || 12);

  // Land comps: class 1 vacant land → $/lot SF (no statewide zoning layer, so no $/buildable SF).
  const landScored = rows.filter(f => f.attributes.PROP_CLASS === '1').map(enrich).filter(x => !x.d.condo && !x.d.units && x.lotSF > 500).map(x => {
    const price = +x.a.SALE_PRICE, adj = price * (1 + x.timeAdj / 100);
    return { address: x.a.PROP_LOC + ', ' + x.a.MUN_NAME, zip: '', neighborhood: x.a.MUN_NAME, category: 'Vacant land', date: x.date, price, lotSF: x.lotSF,
      zoning: '', far: 0, buildableSF: 0, distanceMi: +x.distanceMi.toFixed(2), timeAdj: +x.timeAdj.toFixed(1),
      psfLot: Math.round(adj / x.lotSF), psfBuildable: 0, score: x.distanceMi * 2 + x.ageMo / 12 };
  }).filter(c => c.psfLot > 5 && c.psfLot < 3000).sort((a, b) => a.score - b.score).slice(0, 10);
  const medLSF = median(landScored.map(c => c.psfLot)), byLot = medLSF * lotSF;
  const land = { comps: landScored, medianPsfBuildable: 0, medianPsfLot: Math.round(medLSF), byBuildable: 0, byLot: Math.round(byLot), value: Math.round(byLot),
    method: 'Median time-adjusted $/lot SF of nearby vacant-land deed sales × subject lot area (NJ has no statewide zoning data, so no $/buildable SF)' };

  const radiusMi = +(radiusM / 1609.34).toFixed(1);
  return { version: 'nj-1', state: 'NJ', source: SOURCE, subject, months, zips: [], area: `within ${radiusMi} mi of the address (${S.MUN_NAME}, ${S.COUNTY} County)`,
    candidates: { buildings: bld.length, land: rows.filter(f => f.attributes.PROP_CLASS === '1').length }, comps, land };
}

module.exports = { isNJ, njComps };

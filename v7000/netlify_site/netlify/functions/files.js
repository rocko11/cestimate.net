// netlify/functions/files.js — every file a signed-in user uploads is kept in Netlify Blobs (store "rest-files")
// so admins can open it later. Files go up in chunks because a function request/response is capped near 6 MB.
// POST {action:'start', name, size, type, source}      -> {id, chunkSize}
// POST {action:'chunk', id, n, data:<base64>}          -> {ok}
// POST {action:'finish', id, chunks}                   -> {file}
// POST {action:'list'[, email]}                        -> {files}   (admins: everyone's; others: their own)
// POST {action:'delete', id}                           -> {ok}      (admins)
// GET  ?id=<id>                                        -> {file}    meta
// GET  ?id=<id>&n=<chunk>                              -> {data:<base64>}
const A = require('../lib/auth');

const CHUNK = 3.5 * 1024 * 1024;           // raw bytes per chunk (~4.7 MB as base64, under the 6 MB limit)
const MAX_FILE = 300 * 1024 * 1024;
const json = (code, obj) => ({ statusCode: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });
let _fs = null;
function fstore(event) {
  if (_fs) return _fs;
  const { connectLambda, getStore } = require('@netlify/blobs');
  if (event && event.blobs) connectLambda(event);
  _fs = getStore('rest-files');
  return _fs;
}
const getMeta = async (st, id) => st.get('meta/' + id, { type: 'json' });
const canSee = (me, m) => m && (me.role === 'admin' || m.owner === me.email);
const pub = m => ({ id: m.id, name: m.name, size: m.size, type: m.type, source: m.source, owner: m.owner, ownerName: m.ownerName,
  uploaded: m.uploaded, status: m.status, chunks: m.chunks, chunkSize: m.chunkSize });

exports.handler = async (event) => {
  try {
    const me = await A.requireUser(event);
    if (!me) return A.unauthorized();
    const st = fstore(event);

    if (event.httpMethod === 'GET') {
      const q = event.queryStringParameters || {};
      const id = String(q.id || '');
      if (!/^[a-z0-9-]{6,40}$/.test(id)) return json(400, { error: 'bad id' });
      const m = await getMeta(st, id);
      if (!canSee(me, m)) return json(404, { error: 'Not found' });
      if (q.n === undefined) return json(200, { file: pub(m) });
      const n = parseInt(q.n, 10);
      if (!(n >= 0 && n < m.chunks)) return json(400, { error: 'bad chunk' });
      const buf = await st.get(`chunk/${id}/${n}`, { type: 'arrayBuffer' });
      if (!buf) return json(404, { error: 'Chunk not available yet — try again in a minute' });
      return json(200, { data: Buffer.from(buf).toString('base64') });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }

    if (b.action === 'start') {
      const size = Number(b.size) || 0;
      if (!(size > 0) || size > MAX_FILE) return json(400, { error: 'File size not allowed' });
      const id = Date.now().toString(36) + '-' + require('crypto').randomBytes(6).toString('hex');
      const m = { id, name: String(b.name || 'file').slice(0, 200), size, type: String(b.type || '').slice(0, 100),
        source: String(b.source || 'upload').slice(0, 40), owner: me.email, ownerName: me.name || '', uploaded: new Date().toISOString(),
        status: 'uploading', chunks: Math.ceil(size / CHUNK), chunkSize: CHUNK };
      await st.setJSON('meta/' + id, m);
      return json(200, { id, chunkSize: CHUNK, chunks: m.chunks });
    }
    if (b.action === 'chunk') {
      const id = String(b.id || ''); if (!/^[a-z0-9-]{6,40}$/.test(id)) return json(400, { error: 'bad id' });
      const n = parseInt(b.n, 10);
      const buf = Buffer.from(String(b.data || ''), 'base64');
      if (!(n >= 0 && n < Math.ceil(MAX_FILE / CHUNK)) || !buf.length || buf.length > CHUNK) return json(400, { error: 'bad chunk' });
      // The meta may not be readable yet (eventual consistency), so ownership is checked at 'finish' and on read.
      await st.set(`chunk/${id}/${n}`, buf, { metadata: { owner: me.email } });
      return json(200, { ok: true });
    }
    if (b.action === 'finish') {
      const id = String(b.id || ''); if (!/^[a-z0-9-]{6,40}$/.test(id)) return json(400, { error: 'bad id' });
      let m = null;
      for (let i = 0; i < 6 && !m; i++) { m = await getMeta(st, id); if (!m) await new Promise(r => setTimeout(r, 1000)); }
      if (!m || m.owner !== me.email) return json(404, { error: 'Not found' });
      m.status = 'complete'; m.completed = new Date().toISOString();
      await st.setJSON('meta/' + id, m);
      return json(200, { file: pub(m) });
    }
    if (b.action === 'list') {
      const { blobs } = await st.list({ prefix: 'meta/' });
      const out = [];
      for (const x of blobs) {
        const m = await st.get(x.key, { type: 'json' });
        if (!m || !m.id || !canSee(me, m)) continue;
        if (b.email && m.owner !== A.normEmail(b.email)) continue;
        out.push(pub(m));
      }
      out.sort((a, c) => String(c.uploaded).localeCompare(String(a.uploaded)));
      return json(200, { files: out });
    }
    if (b.action === 'delete') {
      if (me.role !== 'admin') return json(403, { error: 'Admins only' });
      const id = String(b.id || ''); const m = await getMeta(st, id);
      if (!m) return json(404, { error: 'Not found' });
      for (let n = 0; n < m.chunks; n++) await st.delete(`chunk/${id}/${n}`);
      await st.delete('meta/' + id);
      return json(200, { ok: true });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('files error', e);
    return json(500, { error: 'File storage error' });
  }
};

exports._setStore = s => { _fs = s; };

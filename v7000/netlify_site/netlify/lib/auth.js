// netlify/lib/auth.js — accounts and sessions for R Estimator.
// Users live in Netlify Blobs (store "rest-auth"), passwords are scrypt-hashed, and the session is an
// HMAC-signed, HttpOnly cookie. No outside auth service and no setup: the signing secret is AUTH_SECRET
// if set, otherwise generated once and kept in the same store.
const crypto = require('crypto');

const COOKIE = 'rest_session';
const SESSION_DAYS = 30;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'roeipaz@gmail.com,info@p-national.com')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

let _store = null;       // injectable for tests
let _secret = null;
function useStore(s) { _store = s; _secret = null; }
async function store(event) {
  if (_store) return _store;
  const { connectLambda, getStore } = require('@netlify/blobs');
  if (event && event.blobs) connectLambda(event);
  _store = getStore({ name: 'rest-auth', consistency: 'strong' });
  return _store;
}
async function getJSON(st, key) { const v = await st.get(key, { type: 'json' }); return v || null; }

async function secret(event) {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  if (_secret) return _secret;
  const st = await store(event);
  let s = await getJSON(st, 'meta/secret');
  if (!s) {
    await st.setJSON('meta/secret', { v: crypto.randomBytes(48).toString('base64url') }, { onlyIfNew: true }).catch(() => {});
    s = await getJSON(st, 'meta/secret');
  }
  _secret = s.v;
  return _secret;
}

const normEmail = e => String(e || '').trim().toLowerCase();
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 160;
const userKey = e => 'user/' + normEmail(e);

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url');
  return { salt, hash };
}
function checkPassword(pw, u) {
  const { hash } = hashPassword(pw, u.salt);
  const a = Buffer.from(hash), b = Buffer.from(u.hash || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function signSession(event, u) {
  const body = b64({ e: u.email, n: u.name || '', r: u.role, x: Date.now() + SESSION_DAYS * 864e5 });
  const sig = crypto.createHmac('sha256', await secret(event)).update(body).digest('base64url');
  return body + '.' + sig;
}
function readCookie(event, name) {
  const h = (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
  const m = h.split(/;\s*/).find(p => p.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
async function verifySession(event) {
  const tok = readCookie(event, COOKIE);
  if (!tok || tok.indexOf('.') < 0) return null;
  const [body, sig] = tok.split('.');
  const want = crypto.createHmac('sha256', await secret(event)).update(body).digest('base64url');
  if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  let s; try { s = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch (e) { return null; }
  if (!s || !s.e || !(s.x > Date.now())) return null;
  return s;
}
function sessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// For the paid functions: the signed cookie must be valid AND the account must still be active
// (so disabling someone takes effect immediately, not after 30 days).
async function requireUser(event) {
  const s = await verifySession(event);
  if (!s) return null;
  const u = await getJSON(await store(event), userKey(s.e));
  if (!u || u.status !== 'active') return null;
  return u;
}
const unauthorized = () => ({ statusCode: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Please sign in', login: '/login' }) });

module.exports = { COOKIE, ADMIN_EMAILS, useStore, store, getJSON, normEmail, validEmail, userKey, hashPassword, checkPassword,
  signSession, verifySession, sessionCookie, clearCookie, requireUser, unauthorized };

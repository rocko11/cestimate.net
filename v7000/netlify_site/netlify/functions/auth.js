// netlify/functions/auth.js — sign in / request access / sign out / who am I / admin user management.
// GET  ?me                                   -> {user} | 401
// POST {action:'login', email, password}
// POST {action:'signup', name, email, company, password}   (P National admin emails are active at once; others wait for approval)
// POST {action:'logout'}
// POST {action:'list'} | {action:'set', email, status|role} | {action:'reset', email, password} | {action:'delete', email}   (admin only)
// POST {action:'password', current, password}   (change own password)
const A = require('../lib/auth');

const MAX_FAILS = 8, LOCK_MIN = 15;
const json = (code, obj, extra) => ({ statusCode: code, headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, extra || {}), body: JSON.stringify(obj) });
const pub = u => ({ email: u.email, name: u.name, company: u.company || '', role: u.role, status: u.status, created: u.created, lastLogin: u.lastLogin || null });
const pwOk = p => typeof p === 'string' && p.length >= 8 && p.length <= 200;

exports.handler = async (event) => {
  try {
    const st = await A.store(event);
    if (event.httpMethod === 'GET') {
      const u = await A.requireUser(event);
      return u ? json(200, { user: pub(u) }) : json(401, { error: 'Not signed in' });
    }
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let b; try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'Bad request' }); }
    const action = b.action;

    if (action === 'logout') return json(200, { ok: true }, { 'Set-Cookie': A.clearCookie });

    if (action === 'signup') {
      const email = A.normEmail(b.email), name = String(b.name || '').trim().slice(0, 80), company = String(b.company || '').trim().slice(0, 120);
      if (!name) return json(400, { error: 'Enter your name' });
      if (!A.validEmail(email)) return json(400, { error: 'Enter a valid email' });
      if (!pwOk(b.password)) return json(400, { error: 'Password must be at least 8 characters' });
      if (await A.getJSON(st, A.userKey(email))) return json(409, { error: 'An account with this email already exists — sign in instead' });
      const isAdmin = A.ADMIN_EMAILS.includes(email);
      const { salt, hash } = A.hashPassword(b.password);
      const u = { email, name, company, salt, hash, role: isAdmin ? 'admin' : 'user', status: isAdmin ? 'active' : 'pending', created: new Date().toISOString() };
      await st.setJSON(A.userKey(email), u, { onlyIfNew: true });
      if (!isAdmin) return json(200, { pending: true, message: 'Request received. You can sign in as soon as P National approves your account.' });
      u.lastLogin = new Date().toISOString(); await st.setJSON(A.userKey(email), u);
      return json(200, { user: pub(u) }, { 'Set-Cookie': A.sessionCookie(await A.signSession(event, u)) });
    }

    if (action === 'login') {
      const email = A.normEmail(b.email);
      const u = await A.getJSON(st, A.userKey(email));
      const bad = () => json(401, { error: 'Wrong email or password' });
      if (!u) { A.hashPassword(String(b.password || '')); return bad(); }   // same work as a real check
      if (u.lockUntil && u.lockUntil > Date.now()) return json(429, { error: 'Too many attempts — try again in ' + Math.ceil((u.lockUntil - Date.now()) / 60000) + ' min' });
      if (!A.checkPassword(String(b.password || ''), u)) {
        u.fails = (u.fails || 0) + 1;
        if (u.fails >= MAX_FAILS) { u.lockUntil = Date.now() + LOCK_MIN * 60000; u.fails = 0; }
        await st.setJSON(A.userKey(email), u);
        return bad();
      }
      if (u.status === 'pending') return json(403, { error: 'Your account is waiting for approval.' });
      if (u.status !== 'active') return json(403, { error: 'This account is disabled. Contact P National.' });
      u.fails = 0; u.lockUntil = null; u.lastLogin = new Date().toISOString();
      await st.setJSON(A.userKey(email), u);
      return json(200, { user: pub(u) }, { 'Set-Cookie': A.sessionCookie(await A.signSession(event, u)) });
    }

    // Everything below needs a signed-in, active account.
    const me = await A.requireUser(event);
    if (!me) return json(401, { error: 'Not signed in' });

    if (action === 'password') {
      if (!A.checkPassword(String(b.current || ''), me)) return json(401, { error: 'Current password is wrong' });
      if (!pwOk(b.password)) return json(400, { error: 'Password must be at least 8 characters' });
      Object.assign(me, A.hashPassword(b.password)); await st.setJSON(A.userKey(me.email), me);
      return json(200, { ok: true });
    }

    if (me.role !== 'admin') return json(403, { error: 'Admins only' });
    if (action === 'list') {
      const { blobs } = await st.list({ prefix: 'user/' });
      const users = [];
      for (const x of blobs) { const u = await A.getJSON(st, x.key); if (u) users.push(pub(u)); }
      users.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) || String(b.created).localeCompare(String(a.created)));
      return json(200, { users });
    }
    const target = A.normEmail(b.email);
    const u = await A.getJSON(st, A.userKey(target));
    if (!u) return json(404, { error: 'No such user' });
    if (target === me.email && action !== 'reset') return json(400, { error: 'You cannot change your own access here' });
    if (action === 'set') {
      if (b.status && ['active', 'pending', 'disabled'].includes(b.status)) u.status = b.status;
      if (b.role && ['admin', 'user'].includes(b.role)) u.role = b.role;
      await st.setJSON(A.userKey(target), u); return json(200, { user: pub(u) });
    }
    if (action === 'reset') {
      if (!pwOk(b.password)) return json(400, { error: 'Password must be at least 8 characters' });
      Object.assign(u, A.hashPassword(b.password), { fails: 0, lockUntil: null });
      await st.setJSON(A.userKey(target), u); return json(200, { ok: true });
    }
    if (action === 'delete') { await st.delete(A.userKey(target)); return json(200, { ok: true }); }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('auth error', e);
    return json(500, { error: 'Sign-in service error' });
  }
};

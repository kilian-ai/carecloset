import {
  getOrSeedPassword, verifyPassword, createSession, setSessionCookies,
  getClientIp, checkLockoutMs, registerFailure, registerSuccess,
  isHttps, json,
} from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const ip = getClientIp(request);
  const wait = await checkLockoutMs(env, ip);
  if (wait > 0) {
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 1000)}s.`, retryAfterMs: wait },
      { status: 429, headers: { 'retry-after': String(Math.ceil(wait / 1000)) } }
    );
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }
  const password = body && body.password;
  if (typeof password !== 'string' || !password) {
    await registerFailure(env, ip);
    return json({ error: 'invalid credentials' }, { status: 401 });
  }

  const rec = await getOrSeedPassword(env);
  const ok = await verifyPassword(password, rec);
  if (!ok) {
    const lock = await registerFailure(env, ip);
    return json(
      { error: `Too many attempts. Try again in ${Math.ceil(lock / 1000)}s.`, retryAfterMs: lock },
      { status: 401 }
    );
  }

  await registerSuccess(env, ip);
  const token = await createSession(env);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  setSessionCookies(headers, token, isHttps(request));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

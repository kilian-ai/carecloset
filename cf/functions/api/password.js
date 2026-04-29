import { getOrSeedPassword, verifyPassword, setPassword, json } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }
  const { current, next: nextPw } = body || {};
  if (typeof current !== 'string' || typeof nextPw !== 'string' || nextPw.length < 6) {
    return json({ error: 'invalid' }, { status: 400 });
  }
  const rec = await getOrSeedPassword(env);
  const ok = await verifyPassword(current, rec);
  if (!ok) return json({ error: 'wrong current password' }, { status: 403 });
  await setPassword(env, nextPw);
  return json({ ok: true });
}

import { destroySession, clearSessionCookies, isHttps } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  await destroySession(request, env);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
  clearSessionCookies(headers, isHttps(request));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

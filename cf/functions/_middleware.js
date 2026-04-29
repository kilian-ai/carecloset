// Top-level middleware: protect /admin.html and /inventory.html with redirect to /login.html
import { isAuthed } from './_lib/auth.js';

const PROTECTED = new Set(['/admin.html', '/inventory.html', '/categories.html']);

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (!PROTECTED.has(url.pathname)) return next();
  const ok = await isAuthed(request, env);
  if (ok) return next();
  const target = `/login.html?next=${encodeURIComponent(url.pathname + url.search)}`;
  return Response.redirect(new URL(target, url).toString(), 302);
}

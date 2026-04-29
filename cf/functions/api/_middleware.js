import {
  isAuthed, json, parseCookies, isHttps,
} from '../_lib/auth.js';

const PUBLIC = new Set([
  '/api/login',
  '/api/logout',
  '/api/auth-status',
]);

function isPublicPath(pathname, method) {
  if (pathname === '/api/categories' && method === 'GET') return true;
  if (PUBLIC.has(pathname)) return true;
  // Public storefront read of inventory (filters sold)
  if (pathname.startsWith('/api/inventory/')) return true;
  return false;
}

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (isPublicPath(url.pathname, request.method)) return next();
  const ok = await isAuthed(request, env);
  if (!ok) return json({ error: 'unauthorized' }, { status: 401 });
  return next();
}

// Shared auth + crypto helpers for Pages Functions.
// Workers runtime: no node:crypto. Use Web Crypto SubtleCrypto.

const SESSION_COOKIE = 'shop_session';
const AUTH_HINT_COOKIE = 'shop_authed';
const SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days
const PBKDF2_ITER = 100_000;

// Lockout: exponential per IP. Stored in KV `RATELIMIT` (binding).
const LOCK_BASE_MS = 1000;
const LOCK_MAX_MS = 60 * 60 * 1000;
const LOCK_RESET_MS = 24 * 60 * 60 * 1000;

const enc = new TextEncoder();

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return bytesToHex(a);
}

async function pbkdf2(password, saltHex, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: hexToBytes(saltHex), iterations: iter, hash: 'SHA-256' },
    key, 256
  );
  return bytesToHex(bits);
}

export async function hashPassword(password) {
  const salt = randomHex(16);
  const hash = await pbkdf2(password, salt);
  return { salt, hash, iter: PBKDF2_ITER };
}

export async function verifyPassword(password, record) {
  if (!record || !record.salt || !record.hash) return false;
  const candidate = await pbkdf2(password, record.salt, record.iter || PBKDF2_ITER);
  // constant-time compare
  if (candidate.length !== record.hash.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) diff |= candidate.charCodeAt(i) ^ record.hash.charCodeAt(i);
  return diff === 0;
}

export async function getOrSeedPassword(env) {
  const existing = await env.CONFIG.get('password', 'json');
  if (existing) return existing;
  const seed = env.SEED_PASSWORD || 'change-me';
  const rec = await hashPassword(seed);
  await env.CONFIG.put('password', JSON.stringify(rec));
  return rec;
}

export async function setPassword(env, newPassword) {
  const rec = await hashPassword(newPassword);
  await env.CONFIG.put('password', JSON.stringify(rec));
  return rec;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

export async function isAuthed(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const ok = await env.SESSIONS.get(`s:${token}`);
  return !!ok;
}

export async function createSession(env) {
  const token = randomHex(24);
  await env.SESSIONS.put(`s:${token}`, '1', { expirationTtl: SESSION_TTL_S });
  return token;
}

export async function destroySession(request, env) {
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const token = cookies[SESSION_COOKIE];
  if (token) await env.SESSIONS.delete(`s:${token}`);
}

function cookieAttrs(maxAge, secure) {
  const flags = ['HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

function hintCookieAttrs(maxAge, secure) {
  const flags = ['SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (secure) flags.push('Secure');
  return flags.join('; ');
}

export function setSessionCookies(headers, token, isHttps) {
  headers.append('set-cookie', `${SESSION_COOKIE}=${token}; ${cookieAttrs(SESSION_TTL_S, isHttps)}`);
  headers.append('set-cookie', `${AUTH_HINT_COOKIE}=1; ${hintCookieAttrs(SESSION_TTL_S, isHttps)}`);
}

export function clearSessionCookies(headers, isHttps) {
  headers.append('set-cookie', `${SESSION_COOKIE}=; ${cookieAttrs(0, isHttps)}`);
  headers.append('set-cookie', `${AUTH_HINT_COOKIE}=; ${hintCookieAttrs(0, isHttps)}`);
}

// ---- Rate limiting (per IP, exponential, KV-backed) ----

export async function checkLockoutMs(env, ip) {
  const raw = await env.RATELIMIT.get(`fail:${ip}`, 'json');
  if (!raw) return 0;
  if (raw.lastFail && Date.now() - raw.lastFail > LOCK_RESET_MS) {
    await env.RATELIMIT.delete(`fail:${ip}`);
    return 0;
  }
  if (raw.lockedUntil && raw.lockedUntil > Date.now()) {
    return raw.lockedUntil - Date.now();
  }
  return 0;
}

export async function registerFailure(env, ip) {
  const raw = (await env.RATELIMIT.get(`fail:${ip}`, 'json')) || { count: 0 };
  raw.count = (raw.count || 0) + 1;
  raw.lastFail = Date.now();
  const wait = Math.min(LOCK_BASE_MS * Math.pow(2, raw.count - 1), LOCK_MAX_MS);
  raw.lockedUntil = Date.now() + wait;
  await env.RATELIMIT.put(`fail:${ip}`, JSON.stringify(raw), { expirationTtl: 60 * 60 * 24 });
  return wait;
}

export async function registerSuccess(env, ip) {
  await env.RATELIMIT.delete(`fail:${ip}`);
}

export function getClientIp(request) {
  return request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || 'unknown';
}

export function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export function json(body, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { ...init, headers });
}

// ---- Inventory KV helpers ----

const SEED_CATEGORIES = [
  { name: 'mens_outerwear',    title: "Men's Outerwear",    image: '/images/mens_outerwear.jpg' },
  { name: 'ladies_outerwear',  title: 'Ladies Outerwear',    image: '/images/ladies_outerwear.jpg' },
  { name: 'mens_tshirts',      title: "Men's T-Shirts",      image: '/images/mens_tshirts.jpg' },
  { name: 'ladies_tshirts',    title: 'Ladies T-Shirts',     image: '/images/ladies_tshirts.jpg' },
];

async function loadCategoryList(env) {
  const list = await env.INVENTORY.get('categories', 'json');
  if (Array.isArray(list)) return list;
  // seed on first run
  await env.INVENTORY.put('categories', JSON.stringify(SEED_CATEGORIES));
  return SEED_CATEGORIES.slice();
}

async function saveCategoryList(env, list) {
  await env.INVENTORY.put('categories', JSON.stringify(list));
}

export async function listCategories(env) {
  const list = await loadCategoryList(env);
  return list.map(c => c.name);
}

export async function getCategories(env) {
  return loadCategoryList(env);
}

export async function addCategory(env, { name, title, image }) {
  const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error('invalid name');
  if (!title) throw new Error('title required');
  const list = await loadCategoryList(env);
  if (list.some(c => c.name === slug)) throw new Error('category already exists');
  list.push({ name: slug, title, image: image || '' });
  await saveCategoryList(env, list);
  return { name: slug, title, image: image || '' };
}

export async function updateCategory(env, name, patch) {
  const list = await loadCategoryList(env);
  const idx = list.findIndex(c => c.name === name);
  if (idx < 0) throw new Error('not found');
  if ('title' in patch) list[idx].title = patch.title;
  if ('image' in patch) list[idx].image = patch.image;
  await saveCategoryList(env, list);
  return list[idx];
}

export async function deleteCategory(env, name) {
  const list = await loadCategoryList(env);
  const idx = list.findIndex(c => c.name === name);
  if (idx < 0) throw new Error('not found');
  const items = await env.INVENTORY.get(`cat:${name}`, 'json');
  if (Array.isArray(items) && items.length > 0) throw new Error('category not empty');
  list.splice(idx, 1);
  await saveCategoryList(env, list);
  await env.INVENTORY.delete(`cat:${name}`);
}

async function isAllowed(env, category) {
  const list = await loadCategoryList(env);
  return list.some(c => c.name === category);
}

export async function readCategory(env, category) {
  if (!(await isAllowed(env, category))) return null;
  const list = await env.INVENTORY.get(`cat:${category}`, 'json');
  return Array.isArray(list) ? list : [];
}

export async function writeCategory(env, category, list) {
  if (!(await isAllowed(env, category))) throw new Error('unknown category');
  await env.INVENTORY.put(`cat:${category}`, JSON.stringify(list));
}

export function slugify(s) {
  return String(s || '').trim().replace(/\s+/g, '+').replace(/[^A-Za-z0-9+\-_]/g, '');
}

export async function uniqueName(env, category, baseSlug) {
  const list = await readCategory(env, category);
  const existing = new Set(list.map(i => i.name));
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return `${baseSlug}-${i}`;
}

// Save a base64 data URL into R2; return the object key (used as "image" path in items)
export async function saveDataUrlToR2(env, dataUrl, baseName) {
  const m = /^data:image\/([\w+]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) throw new Error('expected image data URL');
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  const key = `${baseName}.${ext}`;
  await env.IMAGES.put(key, bin, { httpMetadata: { contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}` } });
  return `img/${key}`;
}

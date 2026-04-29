import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = path.resolve('data');
const IMAGES_DIR = path.join(DATA_DIR, 'images');
const CONFIG_FILE = path.join(DATA_DIR, 'admin-config.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'admin-sessions.json');
const SEED_PASSWORD = 'c4r3c10s3t61216';
const SESSION_COOKIE = 'shop_session';
const AUTH_HINT_COOKIE = 'shop_authed';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// Rate limiting: exponential lockout per IP
const LOCKOUT_BASE_MS = 1000;       // 1s after first wrong attempt
const LOCKOUT_MAX_MS = 60 * 60 * 1000; // cap at 1 hour
const FAIL_RESET_MS = 24 * 60 * 60 * 1000; // forget failures after 24h of inactivity
const attempts = new Map(); // ip -> { count, lockedUntil, lastFail }

// In-memory session store: token -> expiry timestamp (mirrored to disk)
const sessions = new Map();
let sessionsLoaded = false;

async function loadSessions() {
  if (sessionsLoaded) return;
  sessionsLoaded = true;
  try {
    const raw = JSON.parse(await fs.readFile(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, exp] of Object.entries(raw)) {
      if (exp > now) sessions.set(token, exp);
    }
  } catch { /* no sessions file yet */ }
}

async function persistSessions() {
  const obj = {};
  for (const [t, e] of sessions) obj[t] = e;
  try { await fs.writeFile(SESSIONS_FILE, JSON.stringify(obj)); } catch {}
}

function getClientIp(ctx) {
  const xf = ctx.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return ctx.req.socket?.remoteAddress || 'unknown';
}

function checkLockout(ip) {
  const a = attempts.get(ip);
  if (!a) return 0;
  if (a.lastFail && Date.now() - a.lastFail > FAIL_RESET_MS) {
    attempts.delete(ip);
    return 0;
  }
  if (a.lockedUntil && a.lockedUntil > Date.now()) {
    return a.lockedUntil - Date.now();
  }
  return 0;
}

function registerFailure(ip) {
  const a = attempts.get(ip) || { count: 0, lockedUntil: 0, lastFail: 0 };
  a.count += 1;
  a.lastFail = Date.now();
  // 1st fail → 1s, 2nd → 2s, 3rd → 4s, ...
  const wait = Math.min(LOCKOUT_BASE_MS * Math.pow(2, a.count - 1), LOCKOUT_MAX_MS);
  a.lockedUntil = Date.now() + wait;
  attempts.set(ip, a);
  return wait;
}

function registerSuccess(ip) {
  attempts.delete(ip);
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    const { salt, hash } = hashPassword(SEED_PASSWORD);
    const cfg = { passwordHash: hash, salt };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    console.log(`[admin] seeded ${CONFIG_FILE} with default password`);
    return cfg;
  }
}

async function saveConfig(cfg) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(/;\s*/)) {
    const [k, ...rest] = part.split('=');
    if (k) out[k] = decodeURIComponent(rest.join('='));
  }
  return out;
}

function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  persistSessions();
  return token;
}

function isAuthed(ctx) {
  const cookies = parseCookies(ctx.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;
  const exp = sessions.get(token);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(token); persistSessions(); return false; }
  return true;
}

function setSessionCookie(ctx, token) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // HttpOnly session cookie + a non-HttpOnly hint cookie so the storefront JS
  // can detect login state without an extra request.
  ctx.set('set-cookie', [
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`,
    `${AUTH_HINT_COOKIE}=1; SameSite=Strict; Path=/; Max-Age=${maxAge}`
  ]);
}

function clearSessionCookie(ctx) {
  ctx.set('set-cookie', [
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
    `${AUTH_HINT_COOKIE}=; SameSite=Strict; Path=/; Max-Age=0`
  ]);
}

const PROTECTED_PAGES = new Set(['/admin.html', '/inventory.html', '/categories.html']);
const PUBLIC_API = new Set(['/api/login', '/api/logout', '/api/categories']);

async function listCategories() {
  const files = await fs.readdir(DATA_DIR);
  const exclude = new Set(['admin-config.json', 'admin-sessions.json']);
  return files
    .filter(f => f.endsWith('.json') && !f.startsWith('sample_') && !exclude.has(f))
    .map(f => f.replace(/\.json$/, ''))
    .sort();
}

function slugify(s) {
  return s.trim().replace(/\s+/g, '+').replace(/[^A-Za-z0-9+\-_]/g, '');
}

function extFromDataUrl(dataUrl) {
  const m = /^data:image\/([\w+]+);base64,/.exec(dataUrl || '');
  if (!m) throw new Error('expected image data URL');
  const ext = m[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

async function saveDataUrl(dataUrl, baseName) {
  const ext = extFromDataUrl(dataUrl);
  const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
  const filename = `${baseName}.${ext}`;
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  await fs.writeFile(path.join(IMAGES_DIR, filename), buf);
  return `data/images/${filename}`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => {
      body += c;
      // 25 MB safety cap
      if (body.length > 25 * 1024 * 1024) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function uniqueName(category, baseSlug) {
  const file = path.join(DATA_DIR, `${category}.json`);
  const list = JSON.parse(await fs.readFile(file, 'utf8'));
  const existing = new Set(list.map(i => i.name));
  if (!existing.has(baseSlug)) return baseSlug;
  let i = 2;
  while (existing.has(`${baseSlug}-${i}`)) i++;
  return `${baseSlug}-${i}`;
}

export default {
  nodeResolve: true,
  watch: true,
  open: '/',
  middleware: [
    async (ctx, next) => {
      // Ensure config + sessions loaded (idempotent)
      await loadConfig();
      await loadSessions();

      try {
        // ---- Auth endpoints ----
        if (ctx.path === '/api/login' && ctx.method === 'POST') {
          const ip = getClientIp(ctx);
          const remaining = checkLockout(ip);
          if (remaining > 0) {
            ctx.status = 429;
            ctx.set('retry-after', String(Math.ceil(remaining / 1000)));
            ctx.body = { error: `Too many attempts. Try again in ${Math.ceil(remaining / 1000)}s.`, retryAfterMs: remaining };
            return;
          }
          const { password } = await readJsonBody(ctx.req);
          const cfg = await loadConfig();
          if (!password || !verifyPassword(password, cfg.salt, cfg.passwordHash)) {
            const wait = registerFailure(ip);
            ctx.status = 401;
            ctx.set('retry-after', String(Math.ceil(wait / 1000)));
            ctx.body = { error: 'invalid password', retryAfterMs: wait };
            return;
          }
          registerSuccess(ip);
          const token = newSession();
          setSessionCookie(ctx, token);
          ctx.body = { ok: true };
          return;
        }

        if (ctx.path === '/api/logout' && ctx.method === 'POST') {
          const cookies = parseCookies(ctx.headers.cookie || '');
          const token = cookies[SESSION_COOKIE];
          if (token) { sessions.delete(token); await persistSessions(); }
          clearSessionCookie(ctx);
          ctx.body = { ok: true };
          return;
        }

        if (ctx.path === '/api/auth-status' && ctx.method === 'GET') {
          ctx.body = { authed: isAuthed(ctx) };
          return;
        }

        if (ctx.path === '/api/password' && ctx.method === 'POST') {
          if (!isAuthed(ctx)) { ctx.status = 401; ctx.body = { error: 'not authenticated' }; return; }
          const { current, next: newPassword } = await readJsonBody(ctx.req);
          const cfg = await loadConfig();
          if (!current || !verifyPassword(current, cfg.salt, cfg.passwordHash)) {
            ctx.status = 403; ctx.body = { error: 'current password is incorrect' }; return;
          }
          if (!newPassword || newPassword.length < 6) {
            ctx.status = 400; ctx.body = { error: 'new password must be at least 6 characters' }; return;
          }
          const fresh = hashPassword(newPassword);
          await saveConfig({ passwordHash: fresh.hash, salt: fresh.salt });
          // Invalidate all sessions except current
          const cookies = parseCookies(ctx.headers.cookie || '');
          const keep = cookies[SESSION_COOKIE];
          for (const t of sessions.keys()) if (t !== keep) sessions.delete(t);
          await persistSessions();
          ctx.body = { ok: true };
          return;
        }

        // ---- Protect HTML pages: redirect to /login.html ----
        if (PROTECTED_PAGES.has(ctx.path) && !isAuthed(ctx)) {
          ctx.status = 302;
          ctx.set('location', `/login.html?next=${encodeURIComponent(ctx.path + (ctx.search || ''))}`);
          ctx.body = '';
          return;
        }

        // Public storefront read of inventory (filters sold items)
        const invMatch = /^\/api\/inventory\/([^/]+)$/.exec(ctx.path);
        if (invMatch && ctx.method === 'GET') {
          const category = decodeURIComponent(invMatch[1]);
          const file = path.join(DATA_DIR, `${category}.json`);
          try {
            const list = JSON.parse(await fs.readFile(file, 'utf8'));
            ctx.body = list.filter(i => !i.sold).map(i => ({ ...i, category }));
          } catch {
            ctx.status = 404;
            ctx.body = { error: 'category not found' };
          }
          return;
        }

        // Public checkout: marks items as sold, optional soldTo
        if (ctx.path === '/api/checkout' && ctx.method === 'POST') {
          let body = {};
          try { body = JSON.parse(ctx.request.rawBody || '{}'); } catch {}
          const items = Array.isArray(body.items) ? body.items : [];
          if (!items.length) { ctx.status = 400; ctx.body = { error: 'no items' }; return; }
          if (items.length > 50) { ctx.status = 400; ctx.body = { error: 'too many items' }; return; }
          const soldTo = typeof body.soldTo === 'string' ? body.soldTo.trim().slice(0, 200) : '';
          const soldAt = new Date().toISOString();
          const byCat = new Map();
          for (const it of items) {
            const cat = (it && typeof it.category === 'string') ? it.category.trim() : '';
            const name = (it && typeof it.name === 'string') ? it.name.trim() : '';
            if (!cat || !name) { ctx.status = 400; ctx.body = { error: 'invalid item' }; return; }
            if (!byCat.has(cat)) byCat.set(cat, []);
            byCat.get(cat).push(name);
          }
          const sold = [];
          const missing = [];
          for (const [category, names] of byCat) {
            const file = path.join(DATA_DIR, `${category}.json`);
            let list;
            try { list = JSON.parse(await fs.readFile(file, 'utf8')); }
            catch { for (const n of names) missing.push({ category, name: n }); continue; }
            let dirty = false;
            for (const name of names) {
              const idx = list.findIndex(i => i.name === name);
              if (idx < 0) { missing.push({ category, name }); continue; }
              const it = list[idx];
              if (it.sold) { missing.push({ category, name, reason: 'already sold' }); continue; }
              const updated = { ...it, sold: true, soldAt };
              if (soldTo) updated.soldTo = soldTo;
              list[idx] = updated;
              dirty = true;
              sold.push({ category, name, title: it.title });
            }
            if (dirty) await fs.writeFile(file, JSON.stringify(list, null, 2));
          }
          ctx.body = { ok: true, sold, missing, soldTo: soldTo || null, soldAt };
          return;
        }

        // ---- Protect /api/* (except public ones) ----
        if (ctx.path.startsWith('/api/') && !PUBLIC_API.has(ctx.path) && !isAuthed(ctx)) {
          ctx.status = 401;
          ctx.body = { error: 'not authenticated' };
          return;
        }

        if (ctx.path === '/api/categories' && ctx.method === 'GET') {
          // Return rich objects so storefront can render directly.
          const names = await listCategories();
          const titles = {
            mens_outerwear: "Men's Outerwear",
            ladies_outerwear: 'Ladies Outerwear',
            mens_tshirts: "Men's T-Shirts",
            ladies_tshirts: 'Ladies T-Shirts',
          };
          ctx.body = names.map(n => ({
            name: n,
            title: titles[n] || n,
            image: `/images/${n}.jpg`,
          }));
          return;
        }

        // GET /api/items  -> list every item across all categories (incl. sold)
        if (ctx.path === '/api/items' && ctx.method === 'GET') {
          const cats = await listCategories();
          const all = [];
          for (const c of cats) {
            const list = JSON.parse(await fs.readFile(path.join(DATA_DIR, `${c}.json`), 'utf8'));
            for (const item of list) all.push({ ...item, category: c });
          }
          ctx.body = all;
          return;
        }

        // GET /api/items/:category/:name -> single item
        const itemMatch = /^\/api\/items\/([^/]+)\/([^/]+)$/.exec(ctx.path);
        if (itemMatch) {
          const [, category, name] = itemMatch.map(decodeURIComponent);
          const file = path.join(DATA_DIR, `${category}.json`);
          let list;
          try { list = JSON.parse(await fs.readFile(file, 'utf8')); }
          catch { ctx.status = 404; ctx.body = { error: 'category not found' }; return; }
          const idx = list.findIndex(i => i.name === name);

          if (ctx.method === 'GET') {
            if (idx < 0) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
            ctx.body = { ...list[idx], category };
            return;
          }

          if (ctx.method === 'DELETE') {
            if (idx < 0) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
            list.splice(idx, 1);
            await fs.writeFile(file, JSON.stringify(list, null, 2));
            ctx.status = 204;
            return;
          }

          if (ctx.method === 'PATCH' || ctx.method === 'PUT') {
            if (idx < 0) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
            const body = await readJsonBody(ctx.req);
            const current = list[idx];
            const stamp = Date.now();
            const updated = { ...current };

            // Replace images if new data URLs were provided (accept both naming conventions)
            const newImage = body.image || body.imageDataUrl;
            const newTagImage = body.tagImage || body.tagDataUrl;
            if (newImage && newImage.startsWith('data:')) {
              updated.image = await saveDataUrl(newImage, `${current.name}-${stamp}`);
            }
            if (body.largeImage && body.largeImage.startsWith('data:')) {
              updated.largeImage = await saveDataUrl(body.largeImage, `${current.name}-${stamp}-large`);
            }
            if (newTagImage && newTagImage.startsWith('data:')) {
              await saveDataUrl(newTagImage, `${current.name}-${stamp}-tag`);
            }

            // Scalar fields
            if (typeof body.title === 'string') updated.title = body.title;
            if (body.price !== undefined) updated.price = Number(body.price) || 0;
            if (body.quantity !== undefined) {
              const q = Number(body.quantity);
              updated.quantity = Number.isFinite(q) ? Math.max(0, Math.floor(q)) : 0;
            }
            if (typeof body.description === 'string') updated.description = body.description;
            if (Array.isArray(body.sizes)) {
              const s = body.sizes.map(x => String(x).trim()).filter(Boolean);
              if (s.length) updated.sizes = s; else delete updated.sizes;
            }
            if (body.barcode !== undefined) {
              const b = String(body.barcode).trim();
              if (b) updated.barcode = b; else delete updated.barcode;
            }
            if (body.sold !== undefined) {
              if (body.sold) {
                updated.sold = true;
                if (typeof body.soldTo === 'string') {
                  const t = body.soldTo.trim();
                  if (t) updated.soldTo = t; else delete updated.soldTo;
                }
                if (typeof body.soldAt === 'string' && body.soldAt) {
                  updated.soldAt = body.soldAt;
                }
              } else {
                delete updated.sold;
                delete updated.soldTo;
                delete updated.soldAt;
              }
            }

            // Category move
            const newCat = body.category && body.category !== category ? body.category : null;
            if (newCat) {
              const cats = await listCategories();
              if (!cats.includes(newCat)) {
                ctx.status = 400; ctx.body = { error: `unknown category: ${newCat}` }; return;
              }
              updated.category = newCat;
              list.splice(idx, 1);
              await fs.writeFile(file, JSON.stringify(list, null, 2));
              const targetFile = path.join(DATA_DIR, `${newCat}.json`);
              const targetList = JSON.parse(await fs.readFile(targetFile, 'utf8'));
              targetList.unshift(updated);
              await fs.writeFile(targetFile, JSON.stringify(targetList, null, 2));
            } else {
              updated.category = category;
              list[idx] = updated;
              await fs.writeFile(file, JSON.stringify(list, null, 2));
            }

            ctx.body = updated;
            return;
          }
        }

        if (ctx.path === '/api/items' && ctx.method === 'POST') {
          const body = await readJsonBody(ctx.req);
          const { category, title, price, quantity, sizes, description, largeImage, barcode } = body;
          const image = body.image || body.imageDataUrl;
          const tagImage = body.tagImage || body.tagDataUrl;
          if (!category || !title || !image) {
            ctx.status = 400;
            ctx.body = { error: 'category, title and image are required' };
            return;
          }
          const cats = await listCategories();
          if (!cats.includes(category)) {
            ctx.status = 400;
            ctx.body = { error: `unknown category: ${category}` };
            return;
          }

          const baseSlug = slugify(title) || `item-${Date.now()}`;
          const name = await uniqueName(category, baseSlug);
          const stamp = Date.now();
          const imagePath = await saveDataUrl(image, `${name}-${stamp}`);
          const largeImagePath = largeImage
            ? await saveDataUrl(largeImage, `${name}-${stamp}-large`)
            : imagePath;
          if (tagImage) {
            await saveDataUrl(tagImage, `${name}-${stamp}-tag`);
          }

          const qty = Number.isFinite(Number(quantity)) ? Math.max(0, Math.floor(Number(quantity))) : 1;
          const sizeList = Array.isArray(sizes)
            ? sizes.map(s => String(s).trim()).filter(Boolean)
            : [];
          const item = {
            name,
            title,
            category,
            price: Number(price) || 0,
            quantity: qty,
            ...(sizeList.length ? { sizes: sizeList } : {}),
            description: description || '',
            image: imagePath,
            largeImage: largeImagePath,
            ...(barcode ? { barcode: String(barcode) } : {})
          };

          const file = path.join(DATA_DIR, `${category}.json`);
          const list = JSON.parse(await fs.readFile(file, 'utf8'));
          list.unshift(item);
          await fs.writeFile(file, JSON.stringify(list, null, 2));

          ctx.status = 201;
          ctx.body = item;
          return;
        }
      } catch (err) {
        ctx.status = 500;
        ctx.body = { error: err.message };
        return;
      }
      await next();
    }
  ]
};

// /api/items/<category>/<name>
//   GET    -> single item (admin)
//   PATCH  -> update fields, optionally rename / move category / replace images
//   DELETE -> remove from KV (and best-effort delete R2 objects)
import {
  listCategories, readCategory, writeCategory,
  saveDataUrlToR2, json,
} from '../../../_lib/auth.js';

function findIndex(list, name) { return list.findIndex(i => i.name === name); }

// Cloudflare Pages does not always URL-decode %-escapes in dynamic route params,
// so coerce to a fully decoded string before doing lookups.
function decodeParam(s) {
  if (typeof s !== 'string') return s;
  try { return decodeURIComponent(s); } catch { return s; }
}

function r2KeyFromImagePath(p) {
  if (!p || typeof p !== 'string') return null;
  const m = /^\/?img\/(.+)$/.exec(p);
  return m ? m[1] : null;
}

export async function onRequestGet({ params, env }) {
  const category = decodeParam(params.category);
  const name = decodeParam(params.name);
  const list = await readCategory(env, category);
  if (list === null) return json({ error: 'unknown category' }, { status: 404 });
  const it = list.find(i => i.name === name);
  if (!it) return json({ error: 'not found' }, { status: 404 });
  return json({ ...it, category });
}

export async function onRequestDelete({ params, env }) {
  const category = decodeParam(params.category);
  const name = decodeParam(params.name);
  const list = await readCategory(env, category);
  if (list === null) return json({ error: 'unknown category' }, { status: 404 });
  const idx = findIndex(list, name);
  if (idx < 0) return json({ error: 'not found' }, { status: 404 });
  const [removed] = list.splice(idx, 1);
  await writeCategory(env, category, list);
  // Best-effort R2 cleanup
  for (const p of [removed.image, removed.largeImage, removed.tagImage]) {
    const k = r2KeyFromImagePath(p);
    if (k) { try { await env.IMAGES.delete(k); } catch {} }
  }
  return json({ ok: true });
}

export async function onRequestPatch({ params, request, env }) {
  return patchOrPut({ params, request, env });
}
export async function onRequestPut({ params, request, env }) {
  return patchOrPut({ params, request, env });
}

async function patchOrPut({ params, request, env }) {
  const category = decodeParam(params.category);
  const name = decodeParam(params.name);
  const list = await readCategory(env, category);
  if (list === null) return json({ error: 'unknown category' }, { status: 404 });
  const idx = findIndex(list, name);
  if (idx < 0) return json({ error: 'not found' }, { status: 404 });

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }

  const item = { ...list[idx] };
  const updatable = ['title', 'price', 'quantity', 'sizes', 'description', 'sku', 'sold', 'soldTo', 'soldAt'];
  for (const k of updatable) if (k in body) item[k] = body[k];
  // Clear soldTo/soldAt when an item is unsold
  if ('sold' in body && !body.sold) {
    delete item.soldTo;
    delete item.soldAt;
  }
  if (typeof item.price !== 'undefined') item.price = Number(item.price) || 0;
  if (typeof item.quantity !== 'undefined') item.quantity = Number(item.quantity) || 0;
  if (item.sizes && !Array.isArray(item.sizes)) item.sizes = [];

  // Replace images if provided
  if (body.imageDataUrl) {
    const path = await saveDataUrlToR2(env, body.imageDataUrl, item.name);
    item.image = `/${path}`;
    item.largeImage = `/${path}`;
  }
  if (body.tagDataUrl) {
    const path = await saveDataUrlToR2(env, body.tagDataUrl, `${item.name}-tag`);
    item.tagImage = `/${path}`;
  }

  // Optional category move
  const newCategory = body.category && body.category !== category ? body.category : null;
  if (newCategory && !(await listCategories(env)).includes(newCategory)) {
    return json({ error: 'unknown target category' }, { status: 400 });
  }

  if (newCategory) {
    list.splice(idx, 1);
    await writeCategory(env, category, list);
    const dest = await readCategory(env, newCategory);
    dest.push(item);
    await writeCategory(env, newCategory, dest);
  } else {
    list[idx] = item;
    await writeCategory(env, category, list);
  }

  return json({ ok: true, name: item.name, category: newCategory || category, title: item.title });
}

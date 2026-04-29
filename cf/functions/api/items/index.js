// /api/items
//   GET  -> list ALL items across categories (admin, includes sold)
//   POST -> create new item (multi-part style JSON body with data URLs)
import {
  listCategories, readCategory, writeCategory,
  slugify, uniqueName, saveDataUrlToR2, json,
} from '../../_lib/auth.js';

export async function onRequestGet({ env }) {
  const out = [];
  for (const cat of await listCategories(env)) {
    const list = (await readCategory(env, cat)) || [];
    for (const it of list) out.push({ ...it, category: cat });
  }
  return json(out);
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }

  const {
    title, category, price = 0, quantity = 1,
    sizes = [], description = '', sku = '',
    imageDataUrl, tagDataUrl,
  } = body || {};

  if (!title || !category) return json({ error: 'title and category required' }, { status: 400 });
  const cats = await listCategories(env);
  if (!cats.includes(category)) return json({ error: 'unknown category' }, { status: 400 });

  const baseSlug = slugify(title) || 'item';
  const name = await uniqueName(env, category, baseSlug);

  let image = '';
  let largeImage = '';
  if (imageDataUrl) {
    const path = await saveDataUrlToR2(env, imageDataUrl, name);
    image = `/${path}`;
    largeImage = `/${path}`;
  }
  let tagImage = '';
  if (tagDataUrl) {
    const path = await saveDataUrlToR2(env, tagDataUrl, `${name}-tag`);
    tagImage = `/${path}`;
  }

  const item = {
    name, title,
    price: Number(price) || 0,
    quantity: Number(quantity) || 1,
    sizes: Array.isArray(sizes) ? sizes : [],
    description: String(description || ''),
    sku: String(sku || ''),
    image, largeImage, tagImage,
    sold: false,
    createdAt: Date.now(),
  };

  const list = await readCategory(env, category);
  list.push(item);
  await writeCategory(env, category, list);
  return json({ ok: true, name, category, title: item.title });
}

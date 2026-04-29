// /api/categories
//   GET    -> [{name, title, image}]  (public)
//   POST   -> create  (auth)            body: {name, title, imageDataUrl?}
//   PATCH  -> update  (auth)            body: {name, title?, imageDataUrl?}
//   DELETE -> remove  (auth)            body: {name}  -- only if category empty
import {
  getCategories, addCategory, updateCategory, deleteCategory,
  saveDataUrlToR2, json,
} from '../_lib/auth.js';

export async function onRequestGet({ env }) {
  return json(await getCategories(env));
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }
  const { name, title, imageDataUrl } = body || {};
  try {
    let image = '';
    if (imageDataUrl) {
      const slug = String(name || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      const path = await saveDataUrlToR2(env, imageDataUrl, `cat-${slug}`);
      image = `/${path}`;
    }
    const cat = await addCategory(env, { name, title, image });
    return json({ ok: true, category: cat });
  } catch (e) {
    return json({ error: e.message }, { status: 400 });
  }
}

export async function onRequestPatch({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }
  const { name, title, imageDataUrl } = body || {};
  if (!name) return json({ error: 'name required' }, { status: 400 });
  try {
    const patch = {};
    if (typeof title === 'string') patch.title = title;
    if (imageDataUrl) {
      const path = await saveDataUrlToR2(env, imageDataUrl, `cat-${name}`);
      patch.image = `/${path}`;
    }
    const cat = await updateCategory(env, name, patch);
    return json({ ok: true, category: cat });
  } catch (e) {
    return json({ error: e.message }, { status: e.message === 'not found' ? 404 : 400 });
  }
}

export async function onRequestDelete({ request, env }) {
  let body;
  try { body = await request.json(); } catch { body = {}; }
  const url = new URL(request.url);
  const name = body.name || url.searchParams.get('name');
  if (!name) return json({ error: 'name required' }, { status: 400 });
  try {
    await deleteCategory(env, name);
    return json({ ok: true });
  } catch (e) {
    const status = e.message === 'not found' ? 404 : e.message === 'category not empty' ? 409 : 400;
    return json({ error: e.message }, { status });
  }
}

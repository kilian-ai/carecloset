// Public checkout endpoint. Marks items as sold and records optional buyer name.
// Body: { items: [{ category, name }], soldTo?: string }
import { readCategory, writeCategory, json } from '../_lib/auth.js';

const MAX_ITEMS = 50;
const MAX_NAME = 200;

function clean(s, max) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, { status: 400 }); }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: 'no items' }, { status: 400 });
  if (items.length > MAX_ITEMS) return json({ error: 'too many items' }, { status: 400 });

  const soldTo = clean(body.soldTo, MAX_NAME);
  const soldAt = new Date().toISOString();

  // Group by category to minimize KV reads/writes
  const byCat = new Map();
  for (const it of items) {
    const cat = clean(it.category, 100);
    const name = clean(it.name, 200);
    if (!cat || !name) return json({ error: 'invalid item' }, { status: 400 });
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(name);
  }

  const sold = [];
  const missing = [];

  for (const [category, names] of byCat) {
    const list = await readCategory(env, category);
    if (list === null) {
      for (const n of names) missing.push({ category, name: n });
      continue;
    }
    let dirty = false;
    for (const name of names) {
      const idx = list.findIndex(i => i.name === name);
      if (idx < 0) { missing.push({ category, name }); continue; }
      const it = list[idx];
      if (it.sold) {
        // Already sold — surface as missing so the client can react if needed
        missing.push({ category, name, reason: 'already sold' });
        continue;
      }
      const updated = { ...it, sold: true, soldAt };
      if (soldTo) updated.soldTo = soldTo;
      list[idx] = updated;
      dirty = true;
      sold.push({ category, name, title: it.title });
    }
    if (dirty) await writeCategory(env, category, list);
  }

  return json({ ok: true, sold, missing, soldTo: soldTo || null, soldAt });
}

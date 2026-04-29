// Public storefront read of a single category. Filters out sold items.
import { readCategory, json } from '../../_lib/auth.js';

export async function onRequestGet({ params, env }) {
  const list = await readCategory(env, params.category);
  if (list === null) return json({ error: 'unknown category' }, { status: 404 });
  return json(list.filter(i => !i.sold).map(i => ({ ...i, category: params.category })));
}

// /img/<key> -> stream object from R2
export async function onRequestGet({ params, env, request }) {
  const key = Array.isArray(params.path) ? params.path.join('/') : params.path;
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', 'public, max-age=86400');
  // Conditional request support
  const inm = request.headers.get('if-none-match');
  if (inm && inm === obj.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers });
}

// Bundle Polymer app for Cloudflare Pages.
// - src/shop-app.js (with dynamic imports of lazy-resources.js etc.) -> dist/src/*.js
// - copies static HTML, manifest, top-level images/, webcomponents polyfill
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const OUT = path.join(ROOT, 'cf', 'dist');

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copy(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true });
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function rewriteHtml(srcRel, dstRel, transforms = []) {
  const src = path.join(ROOT, srcRel);
  const dst = path.join(OUT, dstRel);
  let html = await fs.readFile(src, 'utf8');
  for (const [from, to] of transforms) html = html.split(from).join(to);
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.writeFile(dst, html);
}

async function main() {
  console.log('Cleaning dist…');
  await rmrf(OUT);
  await fs.mkdir(OUT, { recursive: true });

  console.log('Bundling src/shop-app.js with esbuild…');
  await build({
    entryPoints: [path.join(ROOT, 'src', 'shop-app.js')],
    bundle: true,
    splitting: true,
    format: 'esm',
    target: ['es2020'],
    outdir: path.join(OUT, 'src'),
    sourcemap: false,
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
  });

  console.log('Copying static assets…');
  // index.html: rewrite webcomponents loader path
  await rewriteHtml('index.html', 'index.html', [
    ['node_modules/@webcomponents/webcomponentsjs/webcomponents-loader.js',
     '/webcomponents/webcomponents-loader.js'],
  ]);

  // Standalone admin/inventory/login pages (no Polymer imports)
  for (const f of ['admin.html', 'inventory.html', 'categories.html', 'login.html', 'manifest.json', 'service-worker.js']) {
    const src = path.join(ROOT, f);
    if (await exists(src)) await copy(src, path.join(OUT, f));
  }

  // Top-level images/ (icons referenced by manifest/index)
  if (await exists(path.join(ROOT, 'images'))) {
    await copy(path.join(ROOT, 'images'), path.join(OUT, 'images'));
  }

  // Webcomponents polyfill bundle
  const wcSrc = path.join(ROOT, 'node_modules', '@webcomponents', 'webcomponentsjs');
  if (await exists(wcSrc)) {
    await copy(wcSrc, path.join(OUT, 'webcomponents'));
  } else {
    console.warn('!! @webcomponents/webcomponentsjs not found in node_modules');
  }

  // _routes.json: tell Pages to NOT invoke functions for static files (cheaper)
  await fs.writeFile(path.join(OUT, '_routes.json'), JSON.stringify({
    version: 1,
    include: ['/api/*', '/img/*', '/admin.html', '/inventory.html', '/categories.html'],
    exclude: [],
  }, null, 2));

  // Copy Pages Functions into dist so a single `wrangler pages deploy ./dist` works
  const fnSrc = path.join(ROOT, 'cf', 'functions');
  if (await exists(fnSrc)) {
    await copy(fnSrc, path.join(OUT, 'functions'));
  }

  console.log('Done. Output ->', OUT);
}

main().catch(e => { console.error(e); process.exit(1); });

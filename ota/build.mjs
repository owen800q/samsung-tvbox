// Build-time half of the over-the-air updates (runtime: ota/ota.js).
//   writeWidget():  the packaged widget: a loader index.html, with the build under app/.
//   writeRelease(): the release assets: ota-manifest.json and ota-<id>.json (the whole build).
// Both identify a build by a hash of its files and page markup, so a TV running
// the build in its widget doesn't download it again.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Widget files that sit next to a build but are not part of it.
const SKIP = new Set(['index.html', 'config.xml', 'icon.png', 'author-signature.xml', 'signature1.xml']);
const TEXT = /\.(m?js|css|json|html|svg|txt|map)$/;

export const REPO = 'owen800q/samsung-tvbox';
// GitHub redirects this to the asset of the release marked "latest".
export const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/ota-manifest.json`;

async function listFiles(dir, prefix = '') {
  const out = [];
  for (const entry of (await readdir(path.join(dir, prefix), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.name.startsWith('.') || (!prefix && SKIP.has(entry.name))) continue;
    if (entry.isDirectory()) out.push(...await listFiles(dir, rel));
    else out.push(rel);
  }
  return out;
}

// Split a page into what the loader inserts: the <head> content without
// <meta charset> (the loader page has it), the <body> attributes and content.
export function splitPage(html) {
  const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html);
  const body = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(html);
  if (!head || !body) throw new Error('page has no <head> or <body>');
  return {
    lang: (/<html[^>]*\slang="([^"]*)"/i.exec(html) || [])[1] || '',
    head: head[1].replace(/<meta\s+charset[^>]*>\s*/i, '').trim(),
    bodyAttrs: body[1],
    body: body[2].trim(),
  };
}

export async function describe(dir, html) {
  const page = splitPage(html);
  const files = [];
  const hash = createHash('sha256').update(JSON.stringify([page.head, page.bodyAttrs, page.body]));
  for (const rel of await listFiles(dir)) {
    const data = await readFile(path.join(dir, rel));
    hash.update(rel).update('\0').update(data);
    files.push({ path: rel, data });
  }
  return { id: hash.digest('hex').slice(0, 16), page, files };
}

// The whole build as one JSON document, as the loader stores it in IndexedDB.
// `length` is the length of `data` (characters), checked after download.
export function bundleOf({ id, page, files }, version) {
  return {
    id, version, page,
    files: files.map(f => {
      const text = TEXT.test(f.path);
      const data = text ? f.data.toString('utf8') : f.data.toString('base64');
      return text ? { path: f.path, length: data.length, data } : { path: f.path, b64: true, length: data.length, data };
    }),
  };
}

// dir: the built app (app/dist); html: its index.html; out: where to write the
// assets; version: shown on the TV; bundleUrl(id): where the TV downloads ota-<id>.json.
export async function writeRelease({ dir, html, out, version, bundleUrl }) {
  const build = await describe(dir, html);
  const bundle = JSON.stringify(bundleOf(build, version));
  const name = `ota-${build.id}.json`;
  await mkdir(out, { recursive: true });
  for (const f of await readdir(out)) if (/^ota-.*\.json$/.test(f)) await rm(path.join(out, f));
  await writeFile(path.join(out, name), bundle);
  const manifest = { id: build.id, version, bundle: bundleUrl(build.id, name), size: Buffer.byteLength(bundle) };
  await writeFile(path.join(out, 'ota-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { id: build.id, name, manifest };
}

// stage: the widget directory being packaged. manifest: the update manifest URL
// (null: no updates). text: notice once an update is downloaded; updated: notice
// on the first launch of a downloaded build. check: a selector the app fills
// when it has started (a downloaded build that leaves it empty is dropped).
export async function writeWidget({ dir, html, stage, key, version, manifest, text, updated, check }) {
  const build = await describe(dir, html);
  for (const f of build.files) {
    await mkdir(path.dirname(path.join(stage, 'app', f.path)), { recursive: true });
    await writeFile(path.join(stage, 'app', f.path), f.data);
  }
  const { page } = build;
  const config = { key, id: build.id, version, manifest, text, updated, check, lang: page.lang, head: page.head, bodyAttrs: page.bodyAttrs, body: page.body };
  await writeFile(path.join(stage, 'ota-config.js'), 'window.__OTA_CONFIG__ = ' + JSON.stringify(config) + ';\n');
  await cp(path.join(here, 'ota.js'), path.join(stage, 'ota.js'));
  const lang = page.lang ? ` lang="${page.lang}"` : '';
  await writeFile(path.join(stage, 'index.html'), `<!doctype html>
<html${lang}>
<head>
  <meta charset="utf-8">
  <script src="ota-config.js"></script>
  <script src="ota.js"></script>
</head>
<body></body>
</html>
`);
  return build.id;
}

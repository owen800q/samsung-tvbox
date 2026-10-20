import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { splitPage, writeRelease, writeWidget, MANIFEST_URL } from './build.mjs';

const page = '<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>T</title></head><body class="x"><div id="root"></div><script src="./assets/a.js"></script></body></html>';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ota-'));
  const dir = path.join(root, 'dist');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), page);
  await writeFile(path.join(dir, 'assets', 'a.js'), 'run("电视")');
  await writeFile(path.join(dir, 'assets', 'i.png'), Buffer.from([0, 1, 2, 255]));
  await writeFile(path.join(dir, 'config.xml'), '<widget/>');
  return { root, dir };
}

test('splitPage keeps what the loader inserts', () => {
  assert.deepEqual(splitPage(page), { lang: 'zh', head: '<title>T</title>', bodyAttrs: ' class="x"', body: '<div id="root"></div><script src="./assets/a.js"></script>' });
});

test('the widget and the release identify the same build alike', async () => {
  const { root, dir } = await fixture();
  const stage = path.join(root, 'widget');
  const id = await writeWidget({ dir, html: page, stage, key: 'k', version: '1.0.0', manifest: MANIFEST_URL, text: 'new', check: '#root' });
  const rel = await writeRelease({ dir, html: page, out: path.join(root, 'release'), version: '1.0.7', bundleUrl: (i, name) => 'https://dl/' + name });
  assert.equal(rel.id, id);

  const manifest = JSON.parse(await readFile(path.join(root, 'release', 'ota-manifest.json'), 'utf8'));
  assert.deepEqual(manifest, { id, version: '1.0.7', bundle: `https://dl/ota-${id}.json`, size: manifest.size });
  const bundle = JSON.parse(await readFile(path.join(root, 'release', `ota-${id}.json`), 'utf8'));
  assert.equal(bundle.id, id);
  assert.deepEqual(bundle.files.map(f => [f.path, f.length, !!f.b64]), [['assets/a.js', 9, false], ['assets/i.png', 8, true]]);
  assert.equal(bundle.files[0].data, 'run("电视")');
  assert.equal(Buffer.from(bundle.files[1].data, 'base64').toString('hex'), '000102ff');
  assert.ok(!bundle.files.some(f => f.path === 'config.xml'));

  const html = await readFile(path.join(stage, 'index.html'), 'utf8');
  assert.match(html, /<html lang="zh">[\s\S]*<script src="ota-config.js"><\/script>\s*<script src="ota.js"><\/script>/);
  assert.equal(await readFile(path.join(stage, 'app', 'assets', 'a.js'), 'utf8'), 'run("电视")');
  const config = await readFile(path.join(stage, 'ota-config.js'), 'utf8');
  assert.match(config, /"manifest":"https:\/\/github.com\/owen800q\/samsung-tvbox\/releases\/latest\/download\/ota-manifest.json"/);
  assert.match(config, new RegExp('"id":"' + id + '"'));
});

test('a change to the page or a file changes the build id', async () => {
  const { root, dir } = await fixture();
  const w = (html, n) => writeRelease({ dir, html, out: path.join(root, n), version: '1', bundleUrl: (i, name) => name });
  const a = (await w(page, 'a')).id;
  const b = (await w(page.replace('T', 'U'), 'b')).id;
  await writeFile(path.join(dir, 'assets', 'a.js'), 'run2()');
  const c = (await w(page, 'c')).id;
  assert.equal(new Set([a, b, c]).size, 3);
});

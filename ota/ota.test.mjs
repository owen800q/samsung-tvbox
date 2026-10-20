import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./ota.js', import.meta.url), 'utf8');
const tick = () => new Promise(r => setTimeout(r, 5));

// A minimal IndexedDB: one database with one object store, async callbacks.
function fakeIdb(data = new Map()) {
  const later = fn => setTimeout(fn, 0);
  const store = {
    get(key) { const r = {}; later(() => { r.result = data.get(key); r.onsuccess && r.onsuccess(); }); return r; },
    put(value, key) { data.set(key, JSON.parse(JSON.stringify(value))); },
    openCursor() {
      const keys = [...data.keys()];
      const r = {};
      let i = 0;
      const step = () => later(() => {
        const key = keys[i++];
        r.result = key === undefined ? null : { key, delete: () => data.delete(key), continue: step };
        r.onsuccess && r.onsuccess();
      });
      step();
      return r;
    },
  };
  return {
    data,
    open() {
      const req = { result: { createObjectStore() {}, transaction() { const tx = { objectStore: () => store }; later(() => tx.oncomplete && tx.oncomplete()); return tx; } } };
      later(() => req.onsuccess && req.onsuccess());
      return req;
    },
  };
}

function fakeDom() {
  const appended = [];
  const el = tag => ({
    tagName: tag.toUpperCase(), attrs: {}, style: {}, firstChild: null,
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
  });
  const body = {
    html: '', attrs: {},
    insertAdjacentHTML(_, h) { this.html += h; },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(e) {
      e.parentNode = body; appended.push(e);
      // "Load" external scripts on the next tick.
      if (e.tagName === 'SCRIPT' && e.src) setTimeout(() => e.onload && e.onload(), 0);
    },
    removeChild() {},
  };
  const head = { html: '', insertAdjacentHTML(_, h) { this.html += h; } };
  return { body, head, appended, el };
}

// Run the loader with a widget config, stored OTA state and stored builds.
function launch(config, { stored, builds, store = new Map(), net = {} } = {}) {
  if (stored) store.set('__ota:' + config.key, JSON.stringify(stored));
  const idb = fakeIdb(builds || new Map());
  const dom = fakeDom();
  let written = '';
  let reloads = 0;
  const listeners = {};
  const docListeners = {};
  const blobs = [];
  const timers = [];
  const window = { __OTA_CONFIG__: config, addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); } };
  const context = {
    window,
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    indexedDB: idb,
    Blob: function (parts, opts) { this.parts = parts; this.type = opts.type; },
    URL: { createObjectURL: b => { blobs.push(b); return 'blob:null/' + blobs.length; } },
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    Uint8Array,
    XMLHttpRequest: function () {
      const x = this;
      x.open = (_, url) => { x.url = url.replace(/[?&]t=\d+$/, ''); };
      x.send = () => setTimeout(() => {
        if (x.url in net) { x.status = 200; x.responseText = net[x.url]; x.onload(); } else x.onerror();
      }, 0);
    },
    document: {
      write: h => { written += h; },
      addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
      getElementsByTagName: () => [],
      querySelector: () => ({ firstChild: {} }),
      createElement: dom.el,
      documentElement: { setAttribute() {} },
      head: dom.head, body: dom.body,
    },
    navigator: { onLine: true },
    location: { reload() { reloads++; } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); if (ms === 0) setTimeout(fn, 0); },
  };
  context.window.document = context.document;
  vm.runInNewContext(source, context);
  const state = () => JSON.parse(store.get('__ota:' + config.key) || '{}');
  return {
    context, window, dom, idb, timers, blobs, state, store,
    get written() { return written; }, get reloads() { return reloads; },
    fireLoad() { for (const f of listeners.load || []) f(); },
  };
}

const bundled = { key: 'tvbox', id: 'own', version: '1.0.1', head: '<title>T</title>', body: '<div id="root"></div>', bodyAttrs: '', text: 'downloaded', updated: 'updated', check: '#root' };
const updatable = { ...bundled, manifest: 'https://gh.example/latest/ota-manifest.json' };
const page = {
  lang: 'zh-CN',
  head: '<script>window.inline1=1</script><title>T</title>',
  bodyAttrs: ' class="x"',
  body: '<div id="root"></div><script id="vite-legacy-polyfill" src="./assets/poly.js"></script><script id="vite-legacy-entry" data-src="./assets/index.js">System.import(1)</script>',
};
const files = [
  { path: 'assets/index.js', length: 9, data: 'index();;' },
  { path: 'assets/poly.js', length: 6, data: 'poly()' },
  { path: 'assets/vendor.js', length: 8, data: 'vendor()' },
];
const cloud = { id: 'cloud', version: '1.0.2', page, files };

test('without a downloaded build the bundled one is written in place', () => {
  const r = launch(updatable);
  assert.match(r.written, /^<base href="app\/"><title>T<\/title><\/head><body><div id="root"><\/div>$/);
  assert.equal(r.window.__ota.remote, false);
  assert.equal(r.window.__ota.version, '1.0.1');
});

test('a downloaded build runs from IndexedDB through blob: URLs, scripts in order', async () => {
  const r = launch(updatable, { stored: { ready: { id: 'cloud', version: '1.0.2' } }, builds: new Map([['cloud', cloud]]) });
  assert.equal(r.window.__ota.remote, true);
  assert.equal(r.window.__ota.version, '1.0.2');
  assert.equal(r.written, '');
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(r.dom.head.html, '<title>T</title>');
  assert.match(r.dom.body.html, /<div id="root"><\/div>/);
  assert.equal(r.dom.body.attrs.class, 'x');
  const scripts = r.dom.appended.filter(e => e.tagName === 'SCRIPT');
  assert.equal(scripts.length, 3);
  assert.equal(scripts[0].text, 'window.inline1=1');
  assert.equal(r.blobs[+scripts[1].src.split('/').pop() - 1].parts[0], 'poly()');
  assert.equal(scripts[1].attrs.id, 'vite-legacy-polyfill');
  assert.equal(scripts[2].attrs['data-src'], './assets/index.js');
  assert.equal(r.state().tries, 1);
});

test('SystemJS resolves the build\'s relative imports to its blobs', async () => {
  const r = launch(updatable, { stored: { ready: { id: 'cloud' } }, builds: new Map([['cloud', cloud]]) });
  // A stand-in for SystemJS, defined as the polyfill chunk would.
  function SystemJS() {}
  SystemJS.prototype.resolve = (id, parent) => new URL(id, parent).href;
  SystemJS.prototype.createScript = function () { return { attrs: { crossorigin: 'anonymous' }, removeAttribute(k) { delete this.attrs[k]; } }; };
  r.window.System = new SystemJS();
  for (let i = 0; i < 10; i++) await tick();
  const S = r.window.System;
  const entry = S.resolve('./assets/index.js');
  const vendor = S.resolve('./vendor.js', entry);
  assert.match(entry, /^blob:/);
  assert.equal(r.blobs[+entry.split('/').pop() - 1].parts[0], 'index();;');
  assert.equal(r.blobs[+vendor.split('/').pop() - 1].parts[0], 'vendor()');
  assert.equal(S.resolve('https://cdn.example/x.js', entry), 'https://cdn.example/x.js');
  assert.deepEqual(S.createScript(entry).attrs, {});
});

test('a build missing from storage falls back to the bundled one without marking it bad', async () => {
  const r = launch(updatable, { stored: { ready: { id: 'cloud' } } });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(r.reloads, 1);
  assert.equal(r.state().ready, null);
  assert.equal(r.state().bad, undefined);
});

test('a build that fails three launches is marked bad and the bundled one runs', () => {
  const r = launch(updatable, { stored: { ready: { id: 'cloud' }, tries: 3 } });
  assert.equal(r.window.__ota.remote, false);
  assert.equal(r.state().bad, 'cloud');
  assert.equal(r.state().ready, null);
});

test('a widget packaged without updates ignores a downloaded build', () => {
  const r = launch(bundled, { stored: { ready: { id: 'cloud' } } });
  assert.equal(r.window.__ota.remote, false);
  assert.equal(r.state().ready, null);
});

const manifest = id => JSON.stringify({ id, version: '1.0.2', bundle: 'https://gh.example/v2/ota-' + id + '.json' });

test('check downloads a new build, validates and stores it', async () => {
  const r = launch(updatable, { net: { [updatable.manifest]: manifest('cloud'), 'https://gh.example/v2/ota-cloud.json': JSON.stringify(cloud) } });
  const result = await new Promise(res => r.window.__ota.check(res));
  assert.equal(result, 'downloaded');
  assert.deepEqual(r.state().ready, { id: 'cloud', version: '1.0.2' });
  assert.equal(r.idb.data.get('cloud').files.length, 3);
  assert.equal(r.window.__ota.pending(), true);
  assert.equal(await new Promise(res => r.window.__ota.check(res)), 'pending');
});

test('check rejects a truncated bundle', async () => {
  const bad = { ...cloud, files: [{ path: 'a.js', length: 10, data: 'short' }] };
  const r = launch(updatable, { net: { [updatable.manifest]: manifest('cloud'), 'https://gh.example/v2/ota-cloud.json': JSON.stringify(bad) } });
  assert.equal(await new Promise(res => r.window.__ota.check(res)), 'error');
  assert.equal(r.state().ready, undefined);
});

test('a manifest naming the bundled build again drops the downloaded one (rollback)', async () => {
  const r = launch(updatable, { stored: { ready: { id: 'cloud' } }, builds: new Map([['cloud', cloud]]), net: { [updatable.manifest]: manifest('own') } });
  assert.equal(await new Promise(res => r.window.__ota.check(res)), 'pending');
  assert.equal(r.state().ready, null);
});

test('check is off without a manifest, and fails cleanly offline', async () => {
  assert.equal(await new Promise(res => launch(bundled).window.__ota.check(res)), 'off');
  assert.equal(await new Promise(res => launch(updatable).window.__ota.check(res)), 'error');
});

test('the loader stays ES5 for Tizen 4.0 (Chromium 56)', () => {
  const stripped = source.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
  assert.doesNotMatch(stripped, /=>|\blet\b|\bconst\b|`|\bclass\b/);
});

// Smoke test against the Samsung TV Web Simulator (Tizen Studio
// tools/sec-tv-simulator), driven over the Chrome DevTools Protocol.
//
// 1. cd app && npm run build && cp ../tizen/config.xml ../tizen/icon.png dist/
// 2. Launch the simulator with the build and a debugging port, e.g. on Linux:
//      Xvfb :99 -screen 0 2200x1400x24 &
//      cd ~/tizen-studio/tools/sec-tv-simulator
//      DISPLAY=:99 ./simulator --file=<repo>/app/dist/index.html --platform=tizentv \
//        --tizentvversion=6.0 --remote-debugging-port=9222 --disableInspector
// 3. node tools/sim-smoke.mjs [--port 9222] [--shots <dir>]
//
// Presses remote keys inside the app frame and checks: the lineup loads, 湖南卫视
// is picked from the channel list and plays, 广东卫视, 东方卫视 and CCTV-13 play after
// typing their numbers, ↑/↓ changes channel, ←/→ changes line, favourites, settings and
// the double-Back exit prompt. Streams come from public IPTV lists over the
// network, so a channel can fail when all of its lines are down that day. A
// channel whose lines all time out, or whose only reachable line is HEVC (the
// simulator can't decode it; the TV can), is a WARN, not a pass.
// Node 22+ (global WebSocket).
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const arg = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : def; };
const PORT = Number(arg('--port', 9222));
const SHOTS = arg('--shots', '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = targets.find(t => t.type === 'page' && /ripple\.html/.test(t.url));
if (!page) throw new Error('Simulator page not found on port ' + PORT);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pending = new Map(); const contexts = [];
ws.onmessage = m => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); }
  else if (msg.method === 'Runtime.executionContextCreated') contexts.push(msg.params.context);
  else if (msg.method === 'Runtime.executionContextDestroyed') { const i = contexts.findIndex(c => c.id === msg.params.executionContextId); if (i >= 0) contexts.splice(i, 1); }
  else if (msg.method === 'Runtime.executionContextsCleared') contexts.length = 0;
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable'); await sleep(300);

// The app runs in a file:// iframe inside the simulator page.
async function ev(expression) {
  const ctx = contexts.filter(c => c.origin === 'file://' && c.auxData && c.auxData.isDefault).pop();
  if (!ctx) throw new Error('App frame not found (is the app running in the simulator?)');
  const r = await send('Runtime.evaluate', { expression, contextId: ctx.id, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}
const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Back: 10009, PlayPause: 10252 };
for (let i = 0; i <= 9; i++) KEYS[String(i)] = 48 + i;
async function key(name, wait = 300) {
  const k = name === 'Back' ? 'XF86Back' : name;
  await ev(`(function(){['keydown','keyup'].forEach(function(t){var e=new KeyboardEvent(t,{key:${JSON.stringify(k)},bubbles:true,cancelable:true});Object.defineProperty(e,'keyCode',{get:function(){return ${KEYS[name]}}});(document.activeElement||document.body).dispatchEvent(e);});return 1})()`);
  await sleep(wait);
}
async function shot(name) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(SHOTS, name + '.png'), Buffer.from(r.data, 'base64'));
}
const tv = () => ev(`(function(){var t=window.__tvbox;return t?{mode:t.mode,cur:t.cur,state:t.state,groups:t.groups}:null})()`);
const video = () => ev(`(function(){var v=document.querySelector('video');return v?{t:Math.round(v.currentTime*10)/10,paused:v.paused,w:v.videoWidth,h:v.videoHeight}:null})()`);
async function waitFor(fn, ms, step = 1000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last && last.ok) return last; await sleep(step); }
  return last;
}
// Wait until the current channel plays (video time advancing) or every line has failed.
async function waitPlaying(ms = 90000) {
  return waitFor(async () => {
    const s = await tv(); const v = await video();
    const ok = s.state.status === 'playing' && v && v.t > 1 && v.w > 0 && !isClip(s.state.url || '');
    return { ok, failed: s.state.status === 'failed', s, v };
  }, ms, 1500).then(r => r || {});
}
const isClip = u => /\.mp4(\?|$)|kwimgs\.com|douyin/i.test(u);
// Why a channel didn't play, from the app's line log: "line 2 bufferAddCodecError (host)".
async function why(key) {
  const log = await ev(`(window.__tvboxLog||[]).filter(function(x){return x.key===${JSON.stringify(key)}&&x.error})`);
  const seen = {};
  for (const x of log) seen[x.url] = x.error;
  return Object.keys(seen).map(u => seen[u] + ' @' + (u.match(/^https?:\/\/([^/]+)/) || [])[1]).join(', ');
}
// The simulator's Chromium can't decode HEVC; the TV can. A channel whose
// reachable lines are all HEVC is a warning here, not a failure.
async function expectPlays(key, r) {
  if (r.ok && r.s.cur.key === key) return playDetail(r);
  const reasons = await why(key);
  if (reasons && reasons.split(', ').every(r => /^超时/.test(r))) return { warn: 'unverified: no line answered from this network (every line timed out): ' + reasons };
  if (/Codec/i.test(reasons)) return { warn: 'no H.264 line reachable; HEVC line found, which the simulator cannot decode (the TV can): ' + reasons };
  throw new Error(playDetail(r) + ' — ' + reasons);
}
const playDetail = r => `${r.s && r.s.cur && r.s.cur.name}: line ${r.s && r.s.state.line}/${r.s && r.s.state.lines}, ${r.v && r.v.w}x${r.v && r.v.h}, t=${r.v && r.v.t}s`;
async function closeOverlays() { for (let i = 0; i < 3 && (await tv()).mode !== 'tv'; i++) await key('Back', 500); }
async function typeNumber(n) { for (const d of String(n)) await key(d, 150); await sleep(2500); }

const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    if (detail && detail.warn) results.push([name, 'warn', detail.warn]);
    else results.push([name, true, detail]);
  } catch (e) { results.push([name, false, e.message]); }
  const r = results[results.length - 1];
  console.log((r[1] === 'warn' ? 'WARN ' : r[1] ? 'PASS ' : 'FAIL ') + name + ' — ' + r[2]);
}
const assert = (ok, msg) => { if (!ok) throw new Error(msg); return msg; };

// The simulator reloads the app frame once shortly after start: wait for the app.
for (let i = 0; i < 60; i++) { try { if (await ev('!!window.__tvbox')) break; } catch (e) { /* frame not ready */ } await sleep(1000); }

await check('Tizen APIs present', async () => assert(await ev(`typeof tizen==='object'&&!!tizen.tvinputdevice`), 'tizen.tvinputdevice'));

await check('lineup loads (央视, 卫视, 广东)', async () => {
  const r = await waitFor(async () => { const s = await tv(); return { ok: s && s.groups.length > 3, s }; }, 60000);
  const g = Object.fromEntries(r.s.groups.map(x => [x.name, x.n]));
  const need = await ev(`[__tvbox.find('CCTV1'),__tvbox.find('湖南卫视'),__tvbox.find('广东卫视'),__tvbox.find('广东珠江')]`);
  return assert(g['央视'] > 15 && g['卫视'] > 20 && g['广东'] > 0 && need.every(Boolean),
    `${r.s.groups.length} groups; 央视 ${g['央视']}, 卫视 ${g['卫视']}, 广东 ${g['广东']}; ` + need.map(c => c && c.key + '#' + c.num + '(' + c.lines + ' lines)').join(', '));
});

await check('startup channel plays or fails over', async () => {
  const r = await waitPlaying(120000); await shot('startup');
  return assert(r.ok || r.failed, playDetail(r) + ' status=' + (r.s && r.s.state.status));
});

await check('channel list → 卫视 → 湖南卫视 plays', async () => {
  await closeOverlays();
  await key('Enter', 600);
  assert((await tv()).mode === 'list', 'list did not open');
  await key('ArrowLeft');
  const groups = (await tv()).groups.map(g => g.name);
  for (let i = 0; i < groups.length && (await ev(`document.querySelector('.groups .sel').textContent`)).indexOf('卫视') !== 0; i++) await key('ArrowDown', 150);
  await key('ArrowRight', 400);
  for (let i = 0; i < 60 && !/湖南卫视/.test(await ev(`document.querySelector('.chans .sel').textContent`)); i++) await key('ArrowDown', 120);
  await shot('list');
  await key('Enter', 500);
  const r = await waitPlaying(); await shot('hunan');
  return expectPlays('湖南卫视', r);
});

await check('↓ changes to the next channel, ↑ back', async () => {
  const a = (await tv()).cur;
  await key('ArrowDown', 800); const b = (await tv()).cur;
  await key('ArrowUp', 800); const c = (await tv()).cur;
  return assert(b.num === a.num + 1 && c.num === a.num, `${a.name} → ${b.name} → ${c.name}`);
});

await check('number keys: 广东卫视 plays', async () => {
  const ch = await ev(`__tvbox.find('广东卫视')`);
  await typeNumber(ch.num);
  const r = await waitPlaying(); await shot('guangdong');
  return expectPlays('广东卫视', r);
});

await check('→ switches line', async () => {
  const before = (await tv()).state;
  assert(before.lines > 1, 'only one line');
  await key('ArrowRight', 800);
  const after = (await tv()).state;
  return assert(after.line === before.line % before.lines + 1, `line ${before.line} → ${after.line} of ${after.lines} (${after.status})`);
});

await check('number keys: 东方卫视 plays', async () => {
  const ch = await ev(`__tvbox.find('东方卫视')`);
  await typeNumber(ch.num);
  const r = await waitPlaying(); await shot('dongfang');
  return expectPlays('东方卫视', r);
});

await check('number keys: CCTV-13 plays', async () => {
  const ch = await ev(`__tvbox.find('CCTV13')`);
  await typeNumber(ch.num);
  const r = await waitPlaying(); await shot('cctv13');
  return expectPlays('CCTV13', r);
});

await check('CCTV-1 (informational: most lines are mainland IP:port hosts)', async () => {
  const ch = await ev(`__tvbox.find('CCTV1')`);
  await typeNumber(ch.num);
  const r = await waitPlaying(); await shot('cctv1');
  return r.ok ? playDetail(r) : 'no line reachable from this network: ' + (await why('CCTV1'));
});

await check('favourite from the list shows the 收藏 group', async () => {
  await key('Enter', 600);
  const had = (await tv()).groups.some(g => g.name === '收藏');
  await key('ArrowRight', 500);
  const has = (await tv()).groups.some(g => g.name === '收藏');
  await key('ArrowRight', 500); // undo
  const after = (await tv()).groups.some(g => g.name === '收藏');
  await key('Back', 500);
  return assert(!had && has && !after, 'added and removed');
});

await check('settings lists the TVAPP sources', async () => {
  await key('Enter', 600);
  await key('ArrowLeft');
  for (let i = 0; i < 80 && (await ev(`document.querySelector('.groups .sel').textContent`)) !== '设置'; i++) await key('ArrowUp', 100);
  await key('Enter', 800);
  const rows = await ev(`[].map.call(document.querySelectorAll('.setrows .row'),function(r){return r.textContent})`);
  await shot('settings');
  await key('Back', 600);
  return assert((await tv()).mode === 'tv' && rows.length > 10 && rows.some(r => /Guovin/.test(r)), rows.length + ' rows');
});

await check('Back once shows the exit prompt', async () => {
  await key('Back', 400);
  const t = await ev(`(document.querySelector('.toast')||{}).textContent||''`);
  await sleep(2600);
  return assert(/再按一次/.test(t), t);
});

ws.close();
const failed = results.filter(r => !r[1]).length;
const warned = results.filter(r => r[1] === 'warn').length;
console.log(`\n${results.length - failed - warned}/${results.length} passed, ${warned} warnings, ${failed} failed`);
process.exit(failed ? 1 : 0);

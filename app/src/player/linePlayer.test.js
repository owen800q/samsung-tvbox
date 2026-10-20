import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeLines, lineOrder, LinePlayer, isClipUrl } from './linePlayer.js';

test('lineOrder: preferred, then winners, then the rest', () => {
  assert.deepEqual(lineOrder(5, [3, 1], -1), [3, 1, 0, 2, 4]);
  assert.deepEqual(lineOrder(5, [3, 1], 4), [4, 3, 1, 0, 2]);
  assert.deepEqual(lineOrder(3, [], -1), [0, 1, 2]);
});

test('probeLines returns answering playlists fastest first, skips clips', async () => {
  const delay = { 'http://a': 50, 'http://b': 10, 'http://d': 30 };
  const fetchHead = url => new Promise((res, rej) => {
    if (url === 'http://c') return rej(new Error('dead'));
    setTimeout(() => res(url === 'http://d' ? '<html>' : url === 'http://f' ? '#EXTM3U\n#EXT-X-ENDLIST' : '#EXTM3U\n'), delay[url] || 5);
  });
  const out = await probeLines(['http://a', 'http://b', 'http://c', 'http://d', 'http://e.mp4', 'http://f'], fetchHead, { grace: 100 });
  assert.deepEqual(out, [1, 0]);
  assert.ok(isClipUrl('http://e.mp4?x=1'));
});

test('probeLines gives up at the timeout', async () => {
  const t = Date.now();
  const out = await probeLines(['http://a'], () => new Promise(() => {}), { timeout: 50 });
  assert.deepEqual(out, []);
  assert.ok(Date.now() - t < 500);
});

// A fake <video> that records src changes and lets the test fire events.
function fakeVideo() {
  const listeners = {};
  return {
    currentTime: 0, paused: true, srcs: [],
    canPlayType: () => 'maybe', // native HLS, like the TV
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    fire(t) { (listeners[t] || []).forEach(f => f()); },
    set src(v) { this.srcs.push(v); },
    removeAttribute() {}, load() {}, pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
  };
}

test('LinePlayer fails over to the next line on error and reports the good one', async () => {
  const v = fakeVideo();
  const states = [];
  const good = [];
  const p = new LinePlayer(v, { onState: s => states.push(s), onGoodLine: (c, u) => good.push(u), fetchHead: () => Promise.reject(new Error('x')) });
  const ch = { key: 'K', urls: ['http://1', 'http://2', 'http://3'] };
  await p.play(ch);
  assert.deepEqual(v.srcs, ['http://1']);
  v.fire('error');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(v.srcs, ['http://1', 'http://2']);
  assert.equal(p.state.line, 2);
  v.currentTime = 1.5; v.fire('timeupdate');
  assert.equal(p.state.status, 'playing');
  assert.deepEqual(good, ['http://2']);
  p.stop();
});

test('LinePlayer starts with the remembered line and stops after trying all', async () => {
  const v = fakeVideo();
  const p = new LinePlayer(v, { fetchHead: () => Promise.reject(new Error('x')) });
  await p.play({ key: 'K', urls: ['http://1', 'http://2'] }, 'http://2');
  assert.deepEqual(v.srcs, ['http://2']);
  v.fire('error'); await new Promise(r => setTimeout(r, 0));
  v.fire('error'); await new Promise(r => setTimeout(r, 0));
  assert.equal(p.state.status, 'failed');
  assert.equal(v.srcs.length, 2);
  p.switchLine(1); await new Promise(r => setTimeout(r, 0));
  assert.equal(v.srcs.length, 3);
  assert.equal(p.state.status, 'loading');
  p.stop();
});

test('switchLine steps through displayed line numbers', async () => {
  const v = fakeVideo();
  const p = new LinePlayer(v, { fetchHead: u => (u === 'http://3' ? Promise.resolve('#EXTM3U') : Promise.reject(new Error('x'))) });
  await p.play({ key: 'K', urls: ['http://1', 'http://2', 'http://3'] });
  assert.equal(p.state.line, 3); // probe winner first
  p.switchLine(1); await new Promise(r => setTimeout(r, 0));
  assert.equal(p.state.line, 1);
  p.switchLine(-1); await new Promise(r => setTimeout(r, 0));
  assert.equal(p.state.line, 3);
  p.stop();
});

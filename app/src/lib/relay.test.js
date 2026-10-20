import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayUrl, withRelay, normalizeRelay, isRelayed } from './relay.js';
import { relayPath } from '../../../relay/server.mjs';

test('the app builds the same relay URLs as the relay server', () => {
  const base = 'https://203.0.113.5:9997/k';
  for (const u of ['http://120.76.248.139/live/bfgd/4200000092.m3u8', 'http://h:82/gslb/zbdq5.m3u8?id=cctv1hd', 'http://x/live.php?id=湖南卫视', 'https://a/b/', 'http://a']) {
    assert.equal(relayUrl(base, u), relayPath(base, u), u);
  }
});

test('normalizeRelay accepts http(s) bases and trims the slash', () => {
  assert.equal(normalizeRelay(' https://203.0.113.5:9997/k/ '), 'https://203.0.113.5:9997/k');
  assert.equal(normalizeRelay('ftp://x'), '');
  assert.equal(normalizeRelay(''), '');
});

test('withRelay appends relayed lines (or puts them first), skipping clips', () => {
  const base = 'https://r/k';
  const ch = { key: 'C', urls: ['http://a/1.m3u8', 'http://b/x.mp4'] };
  const after = withRelay(ch, base);
  assert.deepEqual(after.urls.slice(0, 2), ch.urls);
  assert.equal(after.urls.length, 3);
  assert.ok(isRelayed(base, after.urls[2]));
  assert.ok(isRelayed(base, withRelay(ch, base, true).urls[0]));
  assert.equal(withRelay(ch, ''), ch);
  assert.equal(withRelay(after, base).urls.length, 3);
});

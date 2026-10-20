import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, parseM3u, parseTxt } from './playlist.js';

test('M3U: attributes, quoted commas, multiple entries', () => {
  const text = '﻿#EXTM3U x-tvg-url="a.xml"\n' +
    '#EXTINF:-1 tvg-name="CCTV-1" tvg-logo="http://l/1.png" group-title="📺央视频道",CCTV-1 综合\n' +
    'http://a/cctv1.m3u8\n' +
    '#EXTINF:-1 group-title="a,b",湖南卫视\r\n#EXTVLCOPT:http-user-agent=x\r\nhttps://b/hn.m3u8\r\n';
  const out = parseM3u(text);
  assert.deepEqual(out, [
    { name: 'CCTV-1 综合', group: '📺央视频道', logo: 'http://l/1.png', url: 'http://a/cctv1.m3u8' },
    { name: '湖南卫视', group: 'a,b', logo: '', url: 'https://b/hn.m3u8' },
  ]);
});

test('M3U: #EXTGRP and non-http lines', () => {
  const out = parseM3u('#EXTM3U\n#EXTINF:-1,A\n#EXTGRP:G\nrtmp://x/y\n#EXTINF:-1,B\nhttp://b\n');
  assert.deepEqual(out, [{ name: 'B', group: '', logo: '', url: 'http://b' }]);
});

test('TXT: genres, # separated lines and $ labels', () => {
  const out = parseTxt('央视频道,#genre#\nCCTV1,http://a/1.m3u8$线路1#http://b/1.m3u8\n\n卫视频道,#genre#\n广东卫视,http://g/gd.m3u8\nbad line\n');
  assert.deepEqual(out.map(e => [e.group, e.name, e.url]), [
    ['央视频道', 'CCTV1', 'http://a/1.m3u8'],
    ['央视频道', 'CCTV1', 'http://b/1.m3u8'],
    ['卫视频道', '广东卫视', 'http://g/gd.m3u8'],
  ]);
});

test('parsePlaylist detects the format', () => {
  assert.equal(parsePlaylist('#EXTM3U\n#EXTINF:-1,X\nhttp://x').length, 1);
  assert.equal(parsePlaylist('g,#genre#\nX,http://x').length, 1);
  assert.equal(parsePlaylist('').length, 0);
});

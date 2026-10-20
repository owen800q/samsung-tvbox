import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, encodeTarget, decodeTarget, relayPath, rewritePlaylist, isPrivateAddress } from './server.mjs';

test('targets round-trip through base64url', () => {
  const u = 'http://120.76.248.139/live/bfgd/4200000092.m3u8?a=1&b=中';
  assert.equal(decodeTarget(encodeTarget(u)), u);
  assert.equal(decodeTarget(encodeTarget('file:///etc/passwd')), null);
  assert.equal(relayPath('https://r.example/k/', 'http://h:82/live/cctv1.m3u8?id=1'), 'https://r.example/k/r/' + encodeTarget('http://h:82/live/cctv1.m3u8?id=1') + '/cctv1.m3u8');
});

test('playlists are rewritten: segments, variants, keys and maps', () => {
  const src = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="/init.mp4"\n#EXTINF:6,\nseg1.ts\n#EXTINF:6,\nhttp://other:14311/playurl?x=1&hls_segment=2.ts\n\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi/index.m3u8\n';
  const out = rewritePlaylist(src, 'http://a.example:82/live/x/index.m3u8?t=1', 'https://r/k');
  const via = u => relayPath('https://r/k', u);
  assert.equal(out.split('\n')[1], '#EXT-X-KEY:METHOD=AES-128,URI="' + via('http://a.example:82/live/x/key.bin') + '"');
  assert.equal(out.split('\n')[2], '#EXT-X-MAP:URI="' + via('http://a.example:82/init.mp4') + '"');
  assert.equal(out.split('\n')[4], via('http://a.example:82/live/x/seg1.ts'));
  assert.equal(out.split('\n')[6], via('http://other:14311/playurl?x=1&hls_segment=2.ts'));
  assert.equal(out.split('\n')[9], via('http://a.example:82/live/x/hi/index.m3u8'));
});

test('private, local and metadata addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '::1', 'fd00::1', '::ffff:127.0.0.1', '224.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['120.76.248.139', '8.8.8.8', '2409:8087::1']) assert.ok(!isPrivateAddress(ip), ip);
});

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return 'http://127.0.0.1:' + server.address().port;
}

test('end to end: prefix, playlist rewrite after a redirect, Range on segments, blocked private targets', async t => {
  const upstreamSrv = http.createServer((req, res) => {
    if (req.url === '/redir.m3u8') { res.writeHead(302, { Location: '/live/index.m3u8' }); return res.end(); }
    if (req.url === '/live/index.m3u8') { res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:6,\nseg.ts\n'); }
    if (req.url === '/live/seg.ts') {
      const body = Buffer.from('0123456789');
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (m) { res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Range': `bytes ${m[1]}-${m[2]}/10`, 'Content-Length': +m[2] - +m[1] + 1 }); return res.end(body.subarray(+m[1], +m[2] + 1)); }
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }); return res.end(body);
    }
    res.writeHead(404).end();
  });
  const up = await listen(upstreamSrv);
  const relay = createServer({ PATH_PREFIX: 'secret', RELAY_ALLOW_PRIVATE: '1' });
  const base = (await listen(relay)) + '/secret';
  const strict = createServer({ PATH_PREFIX: 'secret' });
  const strictBase = (await listen(strict)) + '/secret';
  t.after(() => { upstreamSrv.close(); relay.close(); strict.close(); });

  assert.equal((await fetch(base.replace('/secret', '') + '/health')).status, 404);
  const health = await (await fetch(base + '/health')).json();
  assert.equal(health.service, 'tvbox-relay');

  const pl = await fetch(relayPath(base, up + '/redir.m3u8'));
  assert.equal(pl.status, 200);
  assert.equal(pl.headers.get('access-control-allow-origin'), '*');
  const text = await pl.text();
  const segUrl = text.split('\n')[2];
  assert.equal(segUrl, relayPath(base, up + '/live/seg.ts'));

  const seg = await fetch(segUrl, { headers: { Range: 'bytes=2-5' } });
  assert.equal(seg.status, 206);
  assert.equal(seg.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await seg.text(), '2345');

  // By host name, through DNS: allowed here, refused by the strict relay.
  const named = up.replace('127.0.0.1', 'localhost');
  assert.equal(await (await fetch(relayPath(base, named + '/live/seg.ts'))).text(), '0123456789');
  const blockedName = await fetch(relayPath(strictBase, named + '/live/seg.ts'));
  assert.equal(blockedName.status, 502);
  assert.match(await blockedName.text(), /blocked address/);

  const blocked = await fetch(relayPath(strictBase, up + '/live/seg.ts'));
  assert.equal(blocked.status, 502);
  assert.match(await blocked.text(), /blocked address/);
  assert.equal((await fetch(strictBase + '/r/!!!/x')).status, 400);
  assert.ok(relay.stats.bytes > 0);
});

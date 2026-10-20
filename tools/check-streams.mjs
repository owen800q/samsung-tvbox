// Check which lines of the main channels answer from this network.
//   npm run check:streams [-- 湖南卫视 广东卫视 …] [--all-sources]
//
// Loads the subscriptions enabled by default (or all of them with
// --all-sources) the way the app does, then for each channel fetches every
// line's playlist (following a master playlist to its first variant) and the
// first bytes of its first segment. A line passes when the segment answers.
// It doesn't decode video: a line that passes can still be HEVC, which the
// TV plays but the Web Simulator can't.
//
// Results depend on the network: most lines are mainland or US IP:port hosts,
// and some networks (cloud sandboxes, corporate proxies) only allow ports 80/443.
import { SOURCES, candidateUrls } from '../app/src/lib/sources.js';
import { parsePlaylist } from '../app/src/lib/playlist.js';
import { buildLineup } from '../app/src/lib/channels.js';

const args = process.argv.slice(2);
const allSources = args.includes('--all-sources');
const wanted = args.filter(a => !a.startsWith('--'));
const CHANNELS = wanted.length ? wanted : ['CCTV1', 'CCTV5', 'CCTV13', '湖南卫视', '广东卫视', '浙江卫视', '东方卫视', '广东珠江', '广东体育', '广东新闻'];
const TIMEOUT = 8000;

async function get(url, { bytes } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: bytes ? { Range: 'bytes=0-' + (bytes - 1) } : {}, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (!bytes) return { url: res.url, text: await res.text() };
    const reader = res.body.getReader();
    const { value } = await reader.read();
    ctl.abort();
    return { url: res.url, size: value ? value.length : 0 };
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timeout' : (e.cause && e.cause.code) || e.message);
  } finally {
    clearTimeout(timer);
  }
}

const firstUri = text => text.split(/\r?\n/).map(l => l.trim()).find(l => l && l[0] !== '#');

async function checkLine(url) {
  let pl = await get(url);
  if (!/^\s*#EXTM3U/.test(pl.text)) {
    if (/\.(mp4|flv)(\?|$)/i.test(url)) { await get(url, { bytes: 1024 }); return 'file'; }
    throw new Error('not a playlist');
  }
  if (/#EXT-X-STREAM-INF/.test(pl.text)) pl = await get(new URL(firstUri(pl.text), pl.url).href);
  if (/#EXT-X-ENDLIST/.test(pl.text)) throw new Error('recording, not live');
  const seg = firstUri(pl.text);
  if (!seg) throw new Error('empty playlist');
  const segUrl = new URL(seg, pl.url);
  await get(segUrl.href, { bytes: 2048 });
  return 'ok (segments on ' + segUrl.host + ')';
}

const subs = SOURCES.filter(s => (allSources ? !s.ipv6 : s.on));
const lists = [];
for (const s of subs) {
  let text = '';
  for (const u of candidateUrls(s.url)) {
    try { text = (await get(u)).text; break; } catch (e) { /* next mirror */ }
  }
  const entries = parsePlaylist(text);
  console.log(`${entries.length ? '✅' : '❌'} source ${s.name}: ${entries.length} entries`);
  lists.push(entries);
}
const { channels } = buildLineup(lists);
console.log(`${channels.length} channels\n`);

let playable = 0;
for (const key of CHANNELS) {
  const ch = channels.find(c => c.key === key);
  if (!ch) { console.log(`❌ ${key}: not in the lineup`); continue; }
  const res = await Promise.all(ch.urls.map(u => checkLine(u).then(r => [true, r], e => [false, e.message])));
  const ok = res.filter(r => r[0]).length;
  if (ok) playable++;
  console.log(`${ok ? '✅' : '❌'} ${ch.name} (#${ch.num}): ${ok}/${ch.urls.length} lines answer`);
  ch.urls.forEach((u, i) => console.log(`   ${res[i][0] ? '✓' : '✗'} ${i + 1}. ${u.length > 90 ? u.slice(0, 87) + '…' : u}  ${res[i][1]}`));
}
console.log(`\n${playable}/${CHANNELS.length} channels have at least one answering line from this network.`);

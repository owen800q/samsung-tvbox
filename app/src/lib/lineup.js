// Load the enabled subscriptions and build the lineup.
// Each subscription's last good text is cached, so the TV starts playing from
// the cache at once and refreshes in the background.
import { SOURCES, candidateUrls } from './sources.js';
import { parsePlaylist } from './playlist.js';
import { buildLineup } from './channels.js';
import * as store from './storage.js';

const FETCH_TIMEOUT = 15000;
export const REFRESH_AFTER = 6 * 3600 * 1000;

export function fetchText(url, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeout;
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 && xhr.responseText
      ? resolve(xhr.responseText)
      : reject(new Error('HTTP ' + xhr.status)));
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('timeout'));
    xhr.send();
  });
}

export function getSubs() {
  const saved = store.get('subs', null) || {};
  const enabled = saved.enabled || {};
  const list = SOURCES.map(s => ({ ...s, on: enabled[s.id] != null ? !!enabled[s.id] : !!s.on }));
  for (const c of saved.custom || []) list.push({ ...c, custom: true, on: enabled[c.id] != null ? !!enabled[c.id] : true });
  return list;
}

export function saveSubs(list) {
  const enabled = {};
  const custom = [];
  for (const s of list) {
    enabled[s.id] = !!s.on;
    if (s.custom) custom.push({ id: s.id, name: s.name, url: s.url });
  }
  store.set('subs', { enabled, custom });
}

async function fetchSource(src, fetcher) {
  let lastErr;
  for (const url of candidateUrls(src.url)) {
    try {
      const text = await fetcher(url);
      if (parsePlaylist(text).length) return text;
      lastErr = new Error('empty playlist');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function cached(src) {
  const c = store.get('src_' + src.id, null);
  return c && c.text ? c : null;
}

// Build from cache only (instant). Returns null when nothing is cached.
export function lineupFromCache(opts = {}) {
  const subs = getSubs().filter(s => s.on);
  const texts = subs.map(cached).filter(Boolean);
  if (!texts.length) return null;
  return buildLineup(texts.map(c => parsePlaylist(c.text)), opts);
}

export function cacheAge() {
  const subs = getSubs().filter(s => s.on);
  const times = subs.map(cached).filter(Boolean).map(c => c.t);
  return times.length ? Date.now() - Math.min.apply(null, times) : Infinity;
}

// Fetch every enabled subscription (in parallel), fall back to its cache when
// it fails, and build the lineup. status: [{ name, ok, error, count }].
export async function loadLineup(opts = {}, fetcher = fetchText) {
  const subs = getSubs().filter(s => s.on);
  const results = await Promise.all(subs.map(async src => {
    try {
      const text = await fetchSource(src, fetcher);
      store.set('src_' + src.id, { t: Date.now(), text });
      return { src, text, ok: true };
    } catch (e) {
      const c = cached(src);
      return { src, text: c ? c.text : '', ok: false, error: e.message, fromCache: !!c };
    }
  }));
  const lists = results.map(r => parsePlaylist(r.text));
  const status = results.map((r, i) => ({ name: r.src.name, ok: r.ok, error: r.error, fromCache: r.fromCache, count: lists[i].length }));
  return { lineup: buildLineup(lists, opts), status };
}

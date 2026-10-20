// Optional HLS relay (relay/server.mjs) on a server in mainland China, for
// lines that only answer mainland viewers. The relay URL is set on the TV
// (设置 → 中转服务器) and kept only there: it is private, and this repository
// and its builds are public.
//
// A relayed line is {relay}/r/{base64url(url)}/{file name}; the relay rewrites
// playlists so segments go through it too. Keep in step with relay/server.mjs.

function base64url(s) {
  const utf8 = unescape(encodeURIComponent(s));
  const b64 = typeof btoa === 'function' ? btoa(utf8) : Buffer.from(utf8, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function nameOf(url) {
  const m = /\/([^/?#]+)(?:[?#]|$)/.exec(url.replace(/^https?:\/\/[^/]+/i, ''));
  if (!m) return 'index';
  try { return encodeURIComponent(decodeURIComponent(m[1])); } catch (e) { return encodeURIComponent(m[1]); }
}

export function normalizeRelay(base) {
  base = String(base || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(base) ? base : '';
}

export function relayUrl(base, url) {
  return base + '/r/' + base64url(url) + '/' + nameOf(url);
}

export function isRelayed(base, url) {
  return !!base && String(url || '').indexOf(base + '/r/') === 0;
}

// The channel with relayed copies of its lines, after the direct ones (or
// before them with `first`). Clips and lines already on the relay are skipped.
export function withRelay(channel, base, first = false) {
  if (!base) return channel;
  const direct = channel.urls.filter(u => !isRelayed(base, u));
  const relayed = direct.filter(u => /^https?:\/\//i.test(u) && !/\.mp4(\?|$)/i.test(u)).map(u => relayUrl(base, u));
  return { ...channel, urls: first ? relayed.concat(direct) : direct.concat(relayed) };
}

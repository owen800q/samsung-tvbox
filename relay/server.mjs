// HLS relay for samsung-tvbox: lets a TV outside mainland China play lines that
// only answer mainland viewers, by fetching them on a server in China.
// One file, no dependencies, Node 20+. Copy it to the server and run:
//
//   PORT=9997 PATH_PREFIX=<secret> TLS_CERT=cert.pem TLS_KEY=key.pem node server.mjs
//
// Then set 设置 → 中转服务器 on the TV to https://<server>:9997/<secret>.
//
//   GET {base}/r/{base64url(target url)}/{name}  fetch the target (http or https)
//   GET {base}/health                             status and bytes served
//
// Playlists (.m3u8) are rewritten so every variant, segment, key and map URI
// also goes through the relay; anything else streams through as is, with
// Range. Requests outside PATH_PREFIX get 404. The relay refuses private and
// local addresses (the server's own network, cloud metadata) unless
// RELAY_ALLOW_PRIVATE=1 (tests only).
//
// Use HTTPS across China's border: replies to plain-HTTP requests get dropped
// there. TLS_CERT/TLS_KEY are re-read every 12 hours, so a renewed
// certificate is picked up without a restart.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT = 15000;
const MAX_PLAYLIST = 4 * 1024 * 1024;
const UA = 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/76.0.3809.146 TV Safari/537.36';

export function encodeTarget(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeTarget(s) {
  try {
    const url = Buffer.from(s, 'base64url').toString('utf8');
    return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
  } catch (e) {
    return null;
  }
}

// The path segment after the encoded URL: the target's file name, so players
// that look at the extension see ".m3u8" or ".ts".
function nameOf(url) {
  const m = /\/([^/?#]+)(?:[?#]|$)/.exec(url.replace(/^https?:\/\/[^/]+/i, ''));
  return m ? encodeURIComponent(decodeURIComponent(m[1])) : 'index';
}

export function relayPath(base, url) {
  return base.replace(/\/+$/, '') + '/r/' + encodeTarget(url) + '/' + nameOf(url);
}

export function isPlaylist(contentType, url, head) {
  return /mpegurl/i.test(contentType || '') || /\.m3u8?(\?|$)/i.test(url) || /^\s*#EXTM3U/.test(head || '');
}

// Point every URI in an HLS playlist at the relay. `url` is where the playlist
// came from (after redirects); relative URIs resolve against it.
export function rewritePlaylist(text, url, base) {
  const abs = u => { try { return new URL(u, url).href; } catch (e) { return null; } };
  const via = u => { const a = abs(u); return a && /^https?:/i.test(a) ? relayPath(base, a) : u; };
  return text.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t[0] === '#') return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + via(u) + '"');
    return via(t);
  }).join('\n');
}

// Private, loopback, link-local (cloud metadata), CGNAT, multicast and reserved ranges.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff');
}

// DNS lookup that refuses private addresses. Node calls it with all: true
// (it tries every address), which wants an array back.
function safeLookup(allowPrivate) {
  return (host, opts, cb) => {
    dns.lookup(host, opts, (err, address, family) => {
      if (err) return cb(err);
      const list = Array.isArray(address) ? address : [{ address, family }];
      const bad = !allowPrivate && list.find(a => isPrivateAddress(a.address));
      if (bad) return cb(new Error('blocked address ' + bad.address));
      if (Array.isArray(address)) cb(null, address); else cb(null, address, family);
    });
  };
}

// One upstream GET, following redirects. Resolves { res, url } (final URL).
// agents: this relay's own connection pools, so a connection is only reused
// by the relay whose address check opened it.
function upstream(url, headers, allowPrivate, agents, hops = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (!allowPrivate && net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new Error('blocked address ' + u.hostname));
    }
    const mod = u.protocol === 'https:' ? https : http;
    const agent = u.protocol === 'https:' ? agents.https : agents.http;
    const req = mod.get(u, { headers, agent, lookup: safeLookup(allowPrivate), timeout: UPSTREAM_TIMEOUT }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        let next;
        try { next = new URL(res.headers.location, url).href; } catch (e) { return reject(e); }
        if (!/^https?:/i.test(next)) return reject(new Error('bad redirect'));
        return resolve(upstream(next, headers, allowPrivate, agents, hops + 1));
      }
      resolve({ res, url });
    });
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

export function createHandler(env = process.env) {
  const prefix = env.PATH_PREFIX ? '/' + env.PATH_PREFIX.replace(/^\/+|\/+$/g, '') : '';
  const allowPrivate = env.RELAY_ALLOW_PRIVATE === '1';
  const stats = { started: Date.now(), requests: 0, bytes: 0, errors: 0 };
  const agents = { http: new http.Agent({ keepAlive: true, maxSockets: 64 }), https: new https.Agent({ keepAlive: true, maxSockets: 64 }) };
  const handler = async (req, res) => {
    const send = (status, body, type = 'text/plain; charset=utf-8') => {
      if (!res.headersSent) res.writeHead(status, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    let path = (req.url || '/').split('?')[0];
    if (prefix) {
      if (!path.startsWith(prefix + '/')) return send(404, 'Not found');
      path = path.slice(prefix.length);
    }
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'method not allowed');
    if (path === '/health') {
      return send(200, JSON.stringify({ ok: true, service: 'tvbox-relay', uptime: Math.round((Date.now() - stats.started) / 1000), requests: stats.requests, bytes: stats.bytes, errors: stats.errors }), 'application/json');
    }
    const m = /^\/r\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(path);
    const target = m && decodeTarget(m[1]);
    if (!target) return send(400, 'bad target');
    stats.requests++;
    // Public base URL of this relay, as the TV addressed it.
    const proto = req.socket.encrypted ? 'https' : 'http';
    const base = proto + '://' + req.headers.host + prefix;
    const headers = { 'User-Agent': UA, 'Accept': '*/*', 'Accept-Encoding': 'identity' };
    if (req.headers.range) headers.Range = req.headers.range;
    let up;
    try {
      up = await upstream(target, headers, allowPrivate, agents);
    } catch (e) {
      stats.errors++;
      return send(502, 'upstream: ' + e.message);
    }
    const { res: ures, url: finalUrl } = up;
    const type = ures.headers['content-type'] || '';
    if (ures.statusCode === 200 && isPlaylist(type, finalUrl, '')) {
      const chunks = [];
      let size = 0;
      try {
        for await (const c of ures) {
          size += c.length;
          if (size > MAX_PLAYLIST) throw new Error('playlist too large');
          chunks.push(c);
        }
      } catch (e) {
        stats.errors++;
        return send(502, 'upstream: ' + e.message);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (/^\s*#EXTM3U/.test(text)) {
        const out = Buffer.from(rewritePlaylist(text, finalUrl, base), 'utf8');
        stats.bytes += out.length;
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': out.length, 'Cache-Control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : out);
      }
      // Named like a playlist but isn't one: pass it on unchanged.
      const out = Buffer.concat(chunks);
      stats.bytes += out.length;
      res.writeHead(200, { ...CORS, 'Content-Type': type || 'application/octet-stream', 'Content-Length': out.length });
      return res.end(req.method === 'HEAD' ? undefined : out);
    }
    const pass = { ...CORS };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag']) {
      if (ures.headers[h]) pass[h] = ures.headers[h];
    }
    res.writeHead(ures.statusCode, pass);
    if (req.method === 'HEAD') { ures.resume(); return res.end(); }
    ures.on('data', c => { stats.bytes += c.length; });
    ures.on('error', () => res.destroy());
    res.on('close', () => ures.destroy());
    ures.pipe(res);
  };
  handler.stats = stats;
  return handler;
}

export function createServer(env = process.env) {
  const handler = createHandler(env);
  if (!env.TLS_CERT || !env.TLS_KEY) {
    const plain = http.createServer(handler);
    plain.stats = handler.stats;
    return plain;
  }
  const load = () => ({ cert: readFileSync(env.TLS_CERT), key: readFileSync(env.TLS_KEY) });
  const server = https.createServer(load(), handler);
  // Pick up a renewed certificate (Let's Encrypt IP certificates last days, not months).
  setInterval(() => { try { server.setSecureContext(load()); } catch (e) { console.error('reload certificate:', e.message); } }, 12 * 3600e3).unref();
  server.stats = handler.stats;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const env = process.env;
  const port = Number(env.PORT || 9997);
  const server = createServer(env);
  server.listen(port, env.HOST || '0.0.0.0', () => {
    console.log(`tvbox relay on ${env.TLS_CERT ? 'https' : 'http'} :${port}${env.PATH_PREFIX ? ' (prefix set)' : ' (NO PATH_PREFIX: anyone can use it)'}`);
  });
  // Hourly traffic line for `journalctl -u tvbox-relay`.
  let last = 0;
  setInterval(() => {
    const s = server.stats;
    console.log(`traffic: ${((s.bytes - last) / 1e9).toFixed(2)} GB in the last hour, ${(s.bytes / 1e9).toFixed(2)} GB total, ${s.requests} requests, ${s.errors} errors`);
    last = s.bytes;
  }, 3600e3).unref();
}

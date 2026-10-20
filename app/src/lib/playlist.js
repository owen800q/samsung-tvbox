// Parsers for the two live-source formats the TVAPP lists use.
//
// M3U:  #EXTINF:-1 tvg-name="CCTV-1" tvg-logo="…" group-title="📺央视频道",CCTV-1
//       http://host/cctv1.m3u8
// TXT:  央视频道,#genre#
//       CCTV-1,http://a/1.m3u8#http://b/1.m3u8$线路名
//
// Both produce a flat list of entries { name, group, logo, url }; one channel
// usually appears many times with different URLs, and lib/channels.js merges them.

const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function attrs(s) {
  const out = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s))) out[m[1].toLowerCase()] = m[2];
  return out;
}

// Split "#EXTINF:-1 a="x,y" b="z",Name" at the comma that ends the attributes,
// i.e. the first comma outside quotes.
function splitExtinf(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) return [line.slice(0, i), line.slice(i + 1)];
  }
  return [line, ''];
}

// TXT lines may carry a "$label" after the URL, and several URLs joined by "#".
function splitUrls(field) {
  return field.split('#')
    .map(u => u.replace(/\$.*$/, '').trim())
    .filter(u => /^https?:\/\//i.test(u));
}

export function isM3u(text) {
  return /^\s*#EXTM3U/i.test(text) || /#EXTINF/i.test(text.slice(0, 4096));
}

export function parseM3u(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let cur = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#EXTINF/i.test(line)) {
      const [head, name] = splitExtinf(line);
      const a = attrs(head);
      cur = {
        name: (name || a['tvg-name'] || '').trim(),
        group: a['group-title'] || '',
        logo: a['tvg-logo'] || '',
      };
    } else if (/^#EXTGRP:/i.test(line)) {
      if (cur && !cur.group) cur.group = line.slice(8).trim();
    } else if (line[0] === '#') {
      continue;
    } else if (cur) {
      for (const url of splitUrls(line)) out.push({ name: cur.name, group: cur.group, logo: cur.logo, url });
      cur = null;
    }
  }
  return out.filter(e => e.name);
}

export function parseTxt(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const out = [];
  let group = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line.startsWith('//')) continue;
    const i = line.indexOf(',');
    if (i < 0) continue;
    const name = line.slice(0, i).trim();
    const rest = line.slice(i + 1).trim();
    if (/^#genre#$/i.test(rest)) { group = name; continue; }
    for (const url of splitUrls(rest)) out.push({ name, group, logo: '', url });
  }
  return out.filter(e => e.name);
}

export function parsePlaylist(text) {
  if (!text) return [];
  return isM3u(text) ? parseM3u(text) : parseTxt(text);
}

// Over-the-air updates from GitHub Releases. index.html in the widget is this
// loader: it starts either the build shipped inside the widget (app/) or a newer
// build that a previous launch downloaded from the repository's latest release.
//
// GitHub serves release assets as application/octet-stream without CORS or
// long-lived caching, so a build can't be run from GitHub URLs. The loader
// instead downloads the whole build as one JSON asset, keeps it in IndexedDB,
// and runs it from blob: URLs, with SystemJS's resolver pointed at those blobs.
//
// Checking for updates happens in the background after the app is up and
// never during playback; a downloaded build is used from the next launch.
// Written in ES5: Tizen 4.0 TVs run Chromium 56.
(function () {
  'use strict';
  var C = window.__OTA_CONFIG__;
  var KEY = '__ota:' + C.key;
  var DB = 'ota-' + C.key;
  var CHECK_DELAY = 10000;        // after the page has loaded
  var RECHECK_AFTER = 3 * 3600e3; // when the app returns to the foreground
  var HEALTHY_AFTER = 5000;       // after load: a launch that lasts this long counts as working
  var DRAWN_WITHIN = 10000;       // a downloaded build must have drawn C.check by then
  var MAX_FAILED_LAUNCHES = 3;
  var RETRY_BAD_AFTER = 24 * 3600e3;
  var NOTICE_FOR = 15000;
  var UPDATED_NOTICE_AFTER = 1500;
  // Downloaded files are addressed under this made-up base, then mapped to blob: URLs.
  var VBASE = 'https://ota.invalid/';

  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); return true; } catch (e) { return false; } }

  // ---- IndexedDB: one record per downloaded build, keyed by build id ----
  function db(cb) {
    var req;
    try { req = indexedDB.open(DB, 1); } catch (e) { return cb(null); }
    req.onupgradeneeded = function () { req.result.createObjectStore('builds'); };
    req.onsuccess = function () { cb(req.result); };
    req.onerror = req.onblocked = function () { cb(null); };
  }
  function dbGet(id, cb) {
    db(function (d) {
      if (!d) return cb(null);
      try {
        var r = d.transaction('builds', 'readonly').objectStore('builds').get(id);
        r.onsuccess = function () { cb(r.result || null); };
        r.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }
  function dbPut(id, value, cb) {
    db(function (d) {
      if (!d) return cb(false);
      try {
        var tx = d.transaction('builds', 'readwrite');
        tx.objectStore('builds').put(value, id);
        tx.oncomplete = function () { cb(true); };
        tx.onerror = tx.onabort = function () { cb(false); };
      } catch (e) { cb(false); }
    });
  }
  // Delete every stored build except `keep` (ids).
  function dbPrune(keep) {
    db(function (d) {
      if (!d) return;
      try {
        var store = d.transaction('builds', 'readwrite').objectStore('builds');
        var r = store.openCursor();
        r.onsuccess = function () {
          var cur = r.result;
          if (!cur) return;
          if (keep.indexOf(cur.key) < 0) cur['delete']();
          cur['continue']();
        };
      } catch (e) { /* ignore */ }
    });
  }

  // ---- Choose the build ----
  var state = load();
  var bundled = { id: C.id, version: C.version };
  var ready = state.ready;
  if (ready && !C.manifest) {
    // Packaged without updates: ignore a build an earlier install downloaded.
    state.ready = null; state.tries = 0; save(state); ready = null;
  }
  var run = bundled;
  if (ready && ready.id !== C.id && ready.id !== state.bad) {
    // A build that keeps ending its launches early (crash, blank screen) is dropped for the bundled one.
    if ((state.tries || 0) >= MAX_FAILED_LAUNCHES) {
      state.bad = ready.id; state.badAt = Date.now(); state.ready = null; state.tries = 0;
    } else {
      run = ready;
      state.tries = (state.tries || 0) + 1;
    }
    save(state);
  }
  var remote = run !== bundled;
  var fellBack = false;

  // Give up on the downloaded build and start the bundled one. `broken`: the
  // build itself failed (not just its storage), so don't download it again today.
  function fallBack(reason, broken) {
    if (fellBack || !remote) return;
    fellBack = true;
    var s = load();
    if (broken) { s.bad = run.id; s.badAt = Date.now(); }
    s.ready = null; s.tries = 0; s.lastError = String(reason || '');
    save(s);
    location.reload();
  }

  window.__ota = {
    running: run.id, version: run.version, bundled: C.id, remote: remote, enabled: !!C.manifest,
    check: function (cb) { check(true, cb); },
    restart: function () { location.reload(); },
    pending: function () { var s = load(); return !!(s.ready && s.ready.id !== run.id); },
  };

  if (!remote) {
    document.write('<base href="app/">' + C.head + '</head><body' + C.bodyAttrs + '>' + C.body);
  } else {
    dbGet(run.id, function (build) {
      if (!build || !build.files) return fallBack('build missing from storage', false);
      start(build);
    });
  }

  // ---- Run a downloaded build from blob: URLs ----
  function start(build) {
    var urls = {};   // path → blob URL
    var paths = {};  // blob URL → path
    for (var i = 0; i < build.files.length; i++) {
      var f = build.files[i];
      var data = f.b64 ? b64bytes(f.data) : f.data;
      var url = URL.createObjectURL(new Blob([data], { type: mime(f.path) }));
      urls[f.path] = url;
      paths[url] = f.path;
    }
    var hooked = false;
    function hookSystem() {
      var S = window.System;
      if (hooked || !S || !S.constructor || !S.constructor.prototype.resolve) return;
      hooked = true;
      var proto = S.constructor.prototype;
      var resolve = proto.resolve;
      proto.resolve = function (id, parent) {
        var base = parent && paths[parent] ? VBASE + paths[parent] : (parent && parent.indexOf(VBASE) === 0 ? parent : VBASE);
        var url = resolve.call(this, id, base);
        if (url && url.indexOf(VBASE) === 0) {
          var hit = urls[url.slice(VBASE.length).split(/[?#]/)[0]];
          if (hit) return hit;
        }
        return url;
      };
      // SystemJS marks scripts from other origins crossorigin="anonymous"; a
      // file:// page has an opaque origin, so its own blobs could be refused.
      var createScript = proto.createScript;
      if (createScript) {
        proto.createScript = function (url) {
          var el = createScript.apply(this, arguments);
          if (String(url).indexOf('blob:') === 0) { el.removeAttribute('crossorigin'); }
          return el;
        };
      }
    }
    // Map a page-relative src ("./assets/x.js") to its blob.
    function blobFor(src) {
      var p = src.replace(/^\.?\//, '').split(/[?#]/)[0];
      return urls[p] || null;
    }
    function begin() {
      if (C.lang || build.page.lang) document.documentElement.setAttribute('lang', build.page.lang || C.lang);
      var scripts = [];
      var head = splitScripts(build.page.head, scripts);
      var body = splitScripts(build.page.body, scripts);
      document.head.insertAdjacentHTML('beforeend', head);
      document.body.insertAdjacentHTML('beforeend', body);
      var attrs = parseAttrs(build.page.bodyAttrs || '');
      for (var a in attrs) document.body.setAttribute(a, attrs[a]);
      (function next(i) {
        hookSystem();
        if (i === scripts.length) return;
        var spec = scripts[i];
        var el = document.createElement('script');
        for (var k in spec.attrs) if (k !== 'src' && k !== 'type' && k !== 'crossorigin') el.setAttribute(k, spec.attrs[k]);
        if (spec.attrs.src) {
          var src = blobFor(spec.attrs.src);
          if (!src) return fallBack('missing ' + spec.attrs.src, true);
          el.onload = function () { next(i + 1); };
          el.onerror = function () { fallBack('failed ' + spec.attrs.src, true); };
          el.src = src;
          document.body.appendChild(el);
        } else {
          el.text = spec.text;
          document.body.appendChild(el);
          next(i + 1);
        }
      })(0);
    }
    if (document.body) begin(); else document.addEventListener('DOMContentLoaded', begin);
    // The app must have drawn something within DRAWN_WITHIN, or this build is broken.
    if (C.check) {
      setTimeout(function () {
        var el = document.querySelector(C.check);
        if (!el || !el.firstChild) fallBack('nothing drawn in ' + C.check, true);
      }, DRAWN_WITHIN);
    }
    window.addEventListener('unhandledrejection', function (e) {
      var msg = String(e.reason && (e.reason.message || e.reason));
      if (msg.indexOf(VBASE) >= 0 || msg.indexOf('blob:') >= 0) fallBack(msg, true);
    });
  }

  // Pull <script> elements out of markup: returns the markup without them and
  // appends { attrs, text } to `out` in document order.
  function splitScripts(html, out) {
    return String(html || '').replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, function (_, attrs, text) {
      out.push({ attrs: parseAttrs(attrs), text: text });
      return '';
    });
  }
  function parseAttrs(s) {
    var out = {};
    var re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    var m;
    while ((m = re.exec(s))) out[m[1].toLowerCase()] = m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '';
    return out;
  }
  function mime(p) {
    if (/\.m?js$/.test(p)) return 'text/javascript';
    if (/\.css$/.test(p)) return 'text/css';
    if (/\.json$/.test(p)) return 'application/json';
    if (/\.svg$/.test(p)) return 'image/svg+xml';
    if (/\.png$/.test(p)) return 'image/png';
    if (/\.jpe?g$/.test(p)) return 'image/jpeg';
    if (/\.woff2$/.test(p)) return 'font/woff2';
    return 'application/octet-stream';
  }
  function b64bytes(s) {
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // ---- Launch health and update checks ----
  window.addEventListener('load', function () {
    setTimeout(function () {
      if (fellBack) return;
      var s = load();
      if (s.tries) { s.tries = 0; save(s); }
      dbPrune([run.id].concat(s.ready ? [s.ready.id] : []));
    }, HEALTHY_AFTER);
    setTimeout(auto, CHECK_DELAY);
    if (remote && load().shown !== run.id) {
      setTimeout(function () {
        if (fellBack) return;
        var s = load();
        s.shown = run.id;
        save(s);
        toast(C.updated + (run.version ? ' (v' + run.version + ')' : ''));
      }, UPDATED_NOTICE_AFTER);
    }
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Date.now() - (load().checked || 0) > RECHECK_AFTER) auto();
  });

  function playing() {
    var videos = document.getElementsByTagName('video');
    for (var i = 0; i < videos.length; i++) if (!videos[i].paused && !videos[i].ended) return true;
    return false;
  }

  var busy = false;
  function auto() {
    if (fellBack) return;
    if (playing() && !C.checkWhilePlaying) { setTimeout(auto, 60000); return; }
    check(false);
  }

  function get(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.timeout = 120000;
    xhr.onload = function () { cb(xhr.status === 200 ? xhr.responseText : null); };
    xhr.onerror = xhr.ontimeout = function () { cb(null); };
    xhr.send();
  }

  // Validate a downloaded bundle against its manifest entry.
  function valid(m, b) {
    if (!b || b.id !== m.id || !b.page || !b.files || !b.files.length) return false;
    for (var i = 0; i < b.files.length; i++) {
      var f = b.files[i];
      if (typeof f.path !== 'string' || typeof f.data !== 'string' || f.data.length !== f.length) return false;
    }
    return true;
  }

  // cb(result): 'current', 'downloaded', 'pending' (downloaded earlier, applies on restart),
  // 'off' (widget packaged without updates), 'busy' or 'error'.
  function check(manual, cb) {
    cb = cb || function () {};
    if (!C.manifest) return cb('off');
    if (busy) return cb('busy');
    if (navigator.onLine === false) return cb('error');
    busy = true;
    function done(result) { busy = false; cb(result); }
    get(C.manifest + (C.manifest.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), function (text) {
      var m;
      try { m = JSON.parse(text); } catch (e) { m = null; }
      if (!m || !m.id || !m.bundle) return done('error');
      var s = load();
      s.checked = Date.now();
      save(s);
      if (m.id === C.id) {
        // The latest release is the bundled build again (rollback or reinstall): drop any downloaded build.
        if (s.ready) { s.ready = null; s.tries = 0; save(s); }
        return done(run.id === m.id ? 'current' : 'pending');
      }
      if (m.id === run.id) {
        if (s.ready && s.ready.id !== m.id) { s.ready = remote ? { id: run.id, version: run.version } : null; s.tries = 0; save(s); }
        return done('current');
      }
      if (s.ready && s.ready.id === m.id) return done('pending');
      if (m.id === s.bad && !manual && Date.now() - (s.badAt || 0) < RETRY_BAD_AFTER) return done('current');
      get(m.bundle, function (btext) {
        var b;
        try { b = JSON.parse(btext); } catch (e) { b = null; }
        if (!valid(m, b)) return done('error');
        dbPut(m.id, b, function (ok) {
          if (!ok) return done('error');
          var s2 = load();
          s2.ready = { id: m.id, version: m.version || '' };
          s2.tries = 0;
          if (s2.bad === m.id) s2.bad = null;
          if (!save(s2)) return done('error');
          if (!manual) toast(C.text);
          done('downloaded');
        });
      });
    });
  }

  var shownToast = null;
  function toast(text) {
    if (!text || !document.body) return;
    if (shownToast && shownToast.parentNode) shownToast.parentNode.removeChild(shownToast);
    var el = shownToast = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;right:48px;bottom:48px;z-index:2147483647;padding:16px 28px;border-radius:12px;' +
      'background:rgba(20,20,28,.92);color:#fff;font:28px/1.4 sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none';
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, NOTICE_FOR);
  }
})();

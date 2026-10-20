// Plays a channel on a <video>, trying its lines (URLs) until one works.
//
// Public IPTV lists are full of dead links, so a channel typically has 5–20
// lines. On start the player races a quick fetch of the first 12 playlists and
// starts with whichever answers first (or with the line that last worked for
// this channel). Then a line that errors, doesn't start within START_TIMEOUT
// or stalls for STALL_TIMEOUT is dropped for the next one, until every line has
// been tried once.
//
// HLS plays natively on the TV. Where it isn't native (the Web Simulator,
// desktop Chrome), hls.js is loaded on demand.

export const START_TIMEOUT = 10000;
export const STALL_TIMEOUT = 12000;
export const PROBE_TIMEOUT = 3000;
export const PROBE_COUNT = 12;

export function isClipUrl(url) {
  return /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url);
}

// Fetch each candidate playlist at once; resolve with the
// indexes of those that answered with a playlist, fastest first. Resolves early
// at the first answer plus a short grace period, so a fast line isn't kept
// waiting for slow ones.
export function probeLines(urls, fetchHead, { count = PROBE_COUNT, timeout = PROBE_TIMEOUT, grace = 400 } = {}) {
  const idx = [];
  for (let i = 0; i < urls.length && idx.length < count; i++) if (!isClipUrl(urls[i])) idx.push(i);
  if (!idx.length) return Promise.resolve([]);
  return new Promise(resolve => {
    const ok = [];
    let pending = idx.length;
    let done = false;
    let graceTimer = null;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); clearTimeout(graceTimer); resolve(ok.slice()); } };
    const timer = setTimeout(finish, timeout);
    idx.forEach(i => {
      fetchHead(urls[i], timeout).then(text => {
        if (done) return;
        // A playlist with #EXT-X-ENDLIST is a recording, not a live channel.
        if (/^\s*#EXTM3U/.test(text) && !/#EXT-X-ENDLIST/.test(text)) {
          ok.push(i);
          if (!graceTimer) graceTimer = setTimeout(finish, grace);
        }
      }, () => {}).then(() => { if (--pending === 0) finish(); });
    });
  });
}

// Try order: probed winners, then the remembered line, then the rest in list order.
export function lineOrder(n, winners, preferred) {
  const order = [];
  const add = i => { if (i >= 0 && i < n && order.indexOf(i) < 0) order.push(i); };
  if (preferred >= 0) add(preferred);
  winners.forEach(add);
  for (let i = 0; i < n; i++) add(i);
  return order;
}

export function xhrHead(url, timeout) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.timeout = timeout;
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); try { xhr.abort(); } catch (e) { /* ignore */ } } };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 400 ? done(resolve, xhr.responseText || '') : done(reject, new Error('HTTP ' + xhr.status)));
    xhr.onerror = () => done(reject, new Error('network'));
    xhr.ontimeout = () => done(reject, new Error('timeout'));
    xhr.send();
  });
}

export class LinePlayer {
  constructor(video, { onState = () => {}, onGoodLine = () => {}, fetchHead = xhrHead, loadHls } = {}) {
    this.video = video;
    this.onState = onState;
    this.onGoodLine = onGoodLine;
    this.fetchHead = fetchHead;
    this.loadHls = loadHls || (() => import('hls.js').then(m => m.default));
    this.token = 0;
    this.hls = null;
    this.timers = [];
    this.channel = null;
    this.order = [];
    this.pos = 0;
    this.tried = 0;
    this.state = { status: 'idle' };
    this.native = !!(video.canPlayType && video.canPlayType('application/vnd.apple.mpegurl'));
    this._bind();
  }

  _bind() {
    const v = this.video;
    let lastT = 0;
    const progressed = () => {
      if (!this.channel) return;
      const t = v.currentTime || 0;
      if (t > lastT + 0.2 || (this.state.status !== 'playing' && t > 0.3 && !v.paused)) {
        lastT = t;
        this._clear('stall');
        if (this.state.status !== 'playing') {
          this._clear('start');
          this._set({ status: 'playing' });
          this.onGoodLine(this.channel, this.currentUrl());
        }
      }
    };
    v.addEventListener('timeupdate', progressed);
    v.addEventListener('playing', () => { lastT = v.currentTime || 0; });
    v.addEventListener('loadstart', () => { lastT = 0; });
    const stalled = () => {
      if (this.state.status !== 'playing' || this.hasTimer('stall')) return;
      this._timer('stall', STALL_TIMEOUT, () => this._fail('卡顿'));
    };
    v.addEventListener('waiting', stalled);
    v.addEventListener('stalled', stalled);
    v.addEventListener('error', () => { if (this.channel && !this.hls) this._fail('播放错误'); });
    // A live line never ends: one that does is a recording, so move on. A
    // clip (the last resort) loops.
    v.addEventListener('ended', () => {
      if (!this.channel) return;
      if (isClipUrl(this.currentUrl())) { v.currentTime = 0; v.play().catch(() => {}); } else this._fail('直播已结束');
    });
  }

  _set(patch) {
    this.state = Object.assign({}, this.state, patch, {
      key: this.channel && this.channel.key,
      line: this.order[this.pos] != null ? this.order[this.pos] + 1 : 0,
      lines: this.channel ? this.channel.urls.length : 0,
    });
    this.onState(this.state);
  }

  _timer(name, ms, fn) {
    this._clear(name);
    const tok = this.token;
    this.timers.push({ name, id: setTimeout(() => { if (tok === this.token) fn(); }, ms) });
  }

  hasTimer(name) { return this.timers.some(t => t.name === name); }

  _clear(name) {
    this.timers = this.timers.filter(t => {
      if (name && t.name !== name) return true;
      clearTimeout(t.id);
      return false;
    });
  }

  currentUrl() {
    return this.channel ? this.channel.urls[this.order[this.pos]] : '';
  }

  _teardown() {
    this._clear();
    if (this.hls) { try { this.hls.destroy(); } catch (e) { /* ignore */ } this.hls = null; }
    const v = this.video;
    try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) { /* ignore */ }
  }

  // preferredUrl: the line that last worked for this channel, tried first.
  async play(channel, preferredUrl) {
    const tok = ++this.token;
    this._teardown();
    this.channel = channel;
    this.order = [];
    this.pos = 0;
    this.tried = 0;
    const urls = channel.urls;
    const preferred = preferredUrl ? urls.indexOf(preferredUrl) : -1;
    this._set({ status: 'probing', error: '' });
    let winners = [];
    if (preferred < 0 && urls.length > 1) {
      winners = await probeLines(urls, this.fetchHead);
      if (tok !== this.token) return;
    }
    this.order = lineOrder(urls.length, winners, preferred);
    this._attach(tok);
  }

  // Manual line change (left/right on the remote).
  switchLine(delta) {
    if (!this.channel || this.channel.urls.length < 2) return;
    const n = this.channel.urls.length;
    if (!this.order.length) this.order = lineOrder(n, [], -1);
    const tok = ++this.token;
    this._teardown();
    // Step through the line numbers shown on screen, not the try order.
    const target = (this.order[this.pos] + delta + n) % n;
    this.pos = this.order.indexOf(target);
    this.tried = 0;
    this._attach(tok);
  }

  retry() {
    if (!this.channel) return;
    const tok = ++this.token;
    this._teardown();
    this.tried = 0;
    this._attach(tok);
  }

  stop() {
    ++this.token;
    this._teardown();
    this.channel = null;
    this._set({ status: 'idle' });
  }

  _fail(reason) {
    if (!this.channel) return;
    const tok = ++this.token;
    this._teardown();
    this.tried++;
    if (this.tried >= this.order.length) {
      this._set({ status: 'failed', error: reason });
      return;
    }
    this.pos = (this.pos + 1) % this.order.length;
    this._set({ status: 'switching', error: reason });
    this._attach(tok);
  }

  async _attach(tok) {
    const url = this.currentUrl();
    const v = this.video;
    this._set({ status: this.state.status === 'switching' ? 'switching' : 'loading', url });
    this._timer('start', START_TIMEOUT, () => this._fail('超时'));
    if (!this.native && !isClipUrl(url)) {
      let Hls;
      try { Hls = await this.loadHls(); } catch (e) { Hls = null; }
      if (tok !== this.token) return;
      if (Hls && Hls.isSupported()) {
        const h = new Hls({ enableWorker: false, lowLatencyMode: false, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 3 });
        this.hls = h;
        h.on(Hls.Events.ERROR, (_e, data) => {
          if (tok !== this.token || !data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !h._recovered) { h._recovered = true; h.recoverMediaError(); return; }
          this._fail(data.details || '播放错误');
        });
        h.loadSource(url);
        h.attachMedia(v);
        v.play().catch(() => {});
        return;
      }
    }
    v.src = url;
    v.play().catch(() => {});
  }
}

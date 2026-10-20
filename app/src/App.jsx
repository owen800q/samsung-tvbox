import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { LinePlayer } from './player/linePlayer.js';
import { lineupFromCache, loadLineup, cacheAge, REFRESH_AFTER, getSubs, saveSubs } from './lib/lineup.js';
import { GROUP_FAV } from './lib/channels.js';
import * as store from './lib/storage.js';
import { KEY, isBack, digitOf, exitApp } from './platform/tizen.js';
import { APP_VERSION } from './version.js';

const SETTINGS_GROUP = '设置';
// The over-the-air loader (ota/ota.js) when the app runs from the packaged widget.
const ota = typeof window !== 'undefined' ? window.__ota : null;
const VERSION = (ota && ota.version) || APP_VERSION;
const OTA_RESULT = {
  current: '已是最新版本',
  downloaded: '新版本已下载，按 OK 重启后生效',
  pending: '新版本已下载，按 OK 重启后生效',
  busy: '正在检查更新…',
  error: '检查更新失败，请检查网络',
  off: '此安装包未开启自动更新',
};
const BANNER_MS = 5000;
const DIGIT_MS = 1800;

const STATUS_TEXT = {
  probing: '正在测速线路…',
  loading: '加载中…',
  switching: '线路无法播放，正在切换…',
  failed: '所有线路都无法播放',
};

function useLatest(v) { const r = useRef(v); r.current = v; return r; }

function scrollIntoMiddle(el) {
  if (!el || !el.parentNode) return;
  const p = el.parentNode;
  p.scrollTop = Math.max(0, el.offsetTop - p.clientHeight / 2 + el.offsetHeight / 2);
}

export default function App() {
  const videoRef = useRef(null);
  const playerRef = useRef(null);
  const [lineup, setLineup] = useState(() => lineupFromCache({ ipv6: store.get('ipv6', false) }));
  const [loadStatus, setLoadStatus] = useState(lineup ? null : 'loading');
  const [cur, setCur] = useState(null);            // current channel object
  const [pstate, setPstate] = useState({ status: 'idle' });
  const [mode, setMode] = useState('tv');          // tv | list | settings
  const [banner, setBanner] = useState(false);
  const [digits, setDigits] = useState('');
  const [toast, setToast] = useState('');
  const [favs, setFavs] = useState(() => store.get('favs', []));
  const [list, setList] = useState({ g: 0, c: 0, col: 'channel' });
  const [setIdx, setSetIdx] = useState(0);
  const [subs, setSubs] = useState(getSubs);
  const [subsDirty, setSubsDirty] = useState(false);
  const [adding, setAdding] = useState(false);
  const [lastStatus, setLastStatus] = useState(null); // per-source load results
  const [updateReady, setUpdateReady] = useState(() => !!(ota && ota.pending()));
  const timers = useRef({});
  const backAt = useRef(0);

  const later = (name, ms, fn) => { clearTimeout(timers.current[name]); timers.current[name] = setTimeout(fn, ms); };
  const showToast = useCallback(msg => { setToast(msg); later('toast', 2500, () => setToast('')); }, []);
  const showBanner = useCallback(() => { setBanner(true); later('banner', BANNER_MS, () => setBanner(false)); }, []);

  // Groups shown in the channel list: 收藏 first (when any), then the lineup, then 设置.
  const groups = useMemo(() => {
    const out = [];
    const chs = lineup ? lineup.channels : [];
    if (favs.length) {
      const favChannels = favs.map(k => chs.find(c => c.key === k)).filter(Boolean);
      if (favChannels.length) out.push({ name: GROUP_FAV, channels: favChannels });
    }
    if (lineup) out.push(...lineup.groups);
    out.push({ name: SETTINGS_GROUP, channels: [] });
    return out;
  }, [lineup, favs]);

  const play = useCallback((ch) => {
    if (!ch) return;
    setCur(ch);
    store.set('last', ch.key);
    const good = store.get('good', {});
    playerRef.current.play(ch, good[ch.key]);
    showBanner();
  }, [showBanner]);

  // Player
  useEffect(() => {
    const p = new LinePlayer(videoRef.current, {
      onState: s => {
        setPstate(s);
        // Line history for diagnostics (read by tools/sim-smoke.mjs).
        const log = window.__tvboxLog = window.__tvboxLog || [];
        log.push({ t: Date.now(), key: s.key, status: s.status, line: s.line, error: s.error, url: s.url });
        if (log.length > 200) log.shift();
      },
      onGoodLine: (ch, url) => {
        const good = store.get('good', {});
        good[ch.key] = url;
        const keys = Object.keys(good);
        if (keys.length > 400) delete good[keys[0]];
        store.set('good', good);
      },
    });
    playerRef.current = p;
    return () => p.stop();
  }, []);

  const refresh = useCallback(async (manual) => {
    if (manual) showToast('正在刷新频道列表…');
    setLoadStatus(s => s || 'loading');
    const { lineup: fresh, status } = await loadLineup({ ipv6: store.get('ipv6', false) });
    setLastStatus(status);
    store.set('loadedAt', Date.now());
    if (fresh.channels.length) {
      setLineup(fresh);
      setLoadStatus(null);
      if (manual) showToast('已更新：' + fresh.channels.length + ' 个频道');
    } else {
      setLoadStatus(l => (lineup ? null : 'failed'));
      if (manual) showToast('刷新失败，请检查网络或直播源');
    }
    return fresh;
  }, [lineup, showToast]);

  // Startup: play the last channel from the cached lineup, refresh in the background.
  useEffect(() => {
    const start = lu => {
      if (!lu || !lu.channels.length) return;
      const last = store.get('last', '');
      play(lu.channels.find(c => c.key === last) || lu.channels[0]);
    };
    if (lineup) start(lineup);
    if (!lineup || cacheAge() > REFRESH_AFTER) {
      refresh(false).then(fresh => { if (!lineup) start(fresh); });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Read-only hook for tools/sim-smoke.mjs.
  useEffect(() => {
    const p = playerRef.current;
    window.__tvbox = {
      get state() { return p.state; },
      mode, cur: cur && { key: cur.key, num: cur.num, name: cur.name, lines: cur.urls.length },
      groups: groups.map(g => ({ name: g.name, n: g.channels.length })),
      find: key => { const c = lineup && lineup.channels.find(x => x.key === key); return c ? { key: c.key, num: c.num, group: c.group, lines: c.urls.length } : null; },
    };
  }, [mode, cur, groups, lineup]);

  useEffect(() => {
    if (pstate.status && pstate.status !== 'playing') setBanner(true);
    else if (pstate.status === 'playing') later('banner', BANNER_MS, () => setBanner(false));
  }, [pstate.status]);

  const channels = lineup ? lineup.channels : [];
  const step = useCallback(delta => {
    if (!channels.length) return;
    const i = cur ? channels.findIndex(c => c.key === cur.key) : -1;
    play(channels[(i + delta + channels.length) % channels.length]);
  }, [channels, cur, play]);

  const toggleFav = useCallback(ch => {
    if (!ch) return;
    setFavs(prev => {
      const next = prev.indexOf(ch.key) >= 0 ? prev.filter(k => k !== ch.key) : prev.concat(ch.key);
      store.set('favs', next);
      showToast((next.length > prev.length ? '已收藏：' : '已取消收藏：') + ch.name);
      return next;
    });
  }, [showToast]);

  const openList = useCallback(() => {
    let g = 0, c = 0;
    if (cur) {
      const gi = groups.findIndex(gr => gr.name !== GROUP_FAV && gr.channels.some(x => x.key === cur.key));
      if (gi >= 0) { g = gi; c = groups[gi].channels.findIndex(x => x.key === cur.key); }
    }
    setList({ g, c, col: 'channel' });
    setMode('list');
  }, [cur, groups]);

  const openSettings = useCallback(() => { setSubs(getSubs()); setSetIdx(0); setSubsDirty(false); setMode('settings'); }, []);

  const closeSettings = useCallback(() => {
    setMode('tv');
    setAdding(false);
    if (subsDirty) { setSubsDirty(false); refresh(true); }
  }, [subsDirty, refresh]);

  // Settings rows: subscriptions, then actions.
  const settingRows = useMemo(() => {
    const rows = subs.map((s, i) => ({ kind: 'sub', i, label: s.name, on: s.on, hint: s.custom ? s.url : (s.ipv6 ? '仅 IPv6 网络可用' : '') }));
    rows.push({ kind: 'add', label: '＋ 添加自定义直播源（M3U / TXT 地址）' });
    rows.push({ kind: 'ipv6', label: 'IPv6 线路', on: store.get('ipv6', false), hint: '家里网络支持 IPv6 时再打开' });
    rows.push({ kind: 'refresh', label: '立即刷新频道列表' });
    rows.push({ kind: 'clear', label: '清除线路记忆（重新测速）' });
    if (updateReady) rows.push({ kind: 'restart', label: '立即重启，使用新版本' });
    else rows.push({ kind: 'update', label: '检查更新', hint: '当前 v' + VERSION + (ota ? '' : '（开发版）') });
    return rows;
  }, [subs, mode, updateReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const actSetting = useCallback(row => {
    if (row.kind === 'sub') {
      const next = subs.map((s, j) => (j === row.i ? { ...s, on: !s.on } : s));
      setSubs(next); saveSubs(next); setSubsDirty(true);
    } else if (row.kind === 'add') {
      setAdding(true);
    } else if (row.kind === 'ipv6') {
      store.set('ipv6', !store.get('ipv6', false)); setSubsDirty(true); setSubs(subs.slice());
    } else if (row.kind === 'refresh') {
      setSubsDirty(false); setMode('tv'); refresh(true);
    } else if (row.kind === 'update') {
      if (!ota) { showToast('开发版没有在线更新'); return; }
      showToast('正在检查更新…');
      ota.check(result => {
        showToast(OTA_RESULT[result] || result);
        if (result === 'downloaded' || result === 'pending') setUpdateReady(true);
      });
    } else if (row.kind === 'restart') {
      ota && ota.restart();
    } else if (row.kind === 'clear') {
      store.remove('good'); showToast('已清除线路记忆');
    }
  }, [subs, refresh, showToast]);

  const addCustom = useCallback(url => {
    setAdding(false);
    url = (url || '').trim();
    if (!/^https?:\/\/\S+$/i.test(url)) { if (url) showToast('地址无效'); return; }
    const next = subs.concat({ id: 'custom-' + Date.now(), name: '自定义：' + url.replace(/^https?:\/\//, '').slice(0, 40), url, custom: true, on: true });
    setSubs(next); saveSubs(next); setSubsDirty(true);
    showToast('已添加直播源');
  }, [subs, showToast]);

  const enterDigit = useCallback(d => {
    setDigits(prev => {
      const next = (prev + d).slice(-4);
      later('digits', DIGIT_MS, () => {
        setDigits('');
        const n = parseInt(next, 10);
        const ch = channels.find(c => c.num === n);
        if (ch) play(ch); else showToast('没有 ' + n + ' 号频道');
      });
      return next;
    });
  }, [channels, play, showToast]);

  // Remote control
  const ctx = useLatest({ mode, list, groups, cur, step, play, openList, toggleFav, setIdx, settingRows, actSetting, closeSettings, openSettings, adding, enterDigit, showBanner, showToast });
  useEffect(() => {
    const onKey = e => {
      const c = ctx.current;
      const k = e.keyCode;
      if (c.adding) {
        if (isBack(e)) { e.preventDefault(); setAdding(false); }
        return; // the input handles typing and Enter
      }
      const d = digitOf(e);
      let handled = true;
      if (c.mode === 'tv') {
        if (d >= 0) c.enterDigit(String(d));
        else if (k === KEY.UP || k === KEY.CH_DOWN) c.step(-1);
        else if (k === KEY.DOWN || k === KEY.CH_UP) c.step(1);
        else if (k === KEY.LEFT) { playerRef.current.switchLine(-1); c.showBanner(); }
        else if (k === KEY.RIGHT) { playerRef.current.switchLine(1); c.showBanner(); }
        else if (k === KEY.ENTER || k === KEY.CH_LIST) c.openList();
        else if (k === KEY.INFO || k === KEY.YELLOW) c.showBanner();
        else if (k === KEY.RED) c.toggleFav(c.cur);
        else if (k === KEY.GREEN || k === KEY.BLUE) c.openSettings();
        else if (k === KEY.PLAY || k === KEY.PLAY_PAUSE) playerRef.current.retry();
        else if (isBack(e)) {
          const now = Date.now();
          if (now - backAt.current < 2500) exitApp();
          else { backAt.current = now; c.showToast('再按一次返回键退出'); }
        } else handled = false;
      } else if (c.mode === 'list') {
        const { g, c: ci, col } = c.list;
        const group = c.groups[g];
        const n = group ? group.channels.length : 0;
        if (isBack(e)) setMode('tv');
        else if (col === 'group') {
          if (k === KEY.UP) setList({ g: (g - 1 + c.groups.length) % c.groups.length, c: 0, col });
          else if (k === KEY.DOWN) setList({ g: (g + 1) % c.groups.length, c: 0, col });
          else if (k === KEY.RIGHT || k === KEY.ENTER) {
            if (group.name === SETTINGS_GROUP) c.openSettings();
            else if (n) setList({ g, c: 0, col: 'channel' });
          } else handled = false;
        } else {
          if (k === KEY.UP && n) setList({ g, c: (ci - 1 + n) % n, col });
          else if (k === KEY.DOWN && n) setList({ g, c: (ci + 1) % n, col });
          else if ((k === KEY.CH_UP || k === KEY.PAGE_UP) && n) setList({ g, c: Math.max(0, ci - 10), col });
          else if ((k === KEY.CH_DOWN || k === KEY.PAGE_DOWN) && n) setList({ g, c: Math.min(n - 1, ci + 10), col });
          else if (k === KEY.LEFT) setList({ g, c: ci, col: 'group' });
          else if (k === KEY.RIGHT || k === KEY.RED) c.toggleFav(group.channels[ci]);
          else if (k === KEY.ENTER && group.channels[ci]) { c.play(group.channels[ci]); setMode('tv'); }
          else handled = false;
        }
      } else if (c.mode === 'settings') {
        const rows = c.settingRows;
        if (isBack(e) || k === KEY.LEFT) c.closeSettings();
        else if (k === KEY.UP) setSetIdx(i => (i - 1 + rows.length) % rows.length);
        else if (k === KEY.DOWN) setSetIdx(i => (i + 1) % rows.length);
        else if (k === KEY.ENTER) c.actSetting(rows[c.setIdx]);
        else handled = false;
      }
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ctx]);

  // Keep the focused rows in view.
  const groupColRef = useRef(null);
  const chanColRef = useRef(null);
  const setColRef = useRef(null);
  useEffect(() => {
    if (mode === 'list') {
      scrollIntoMiddle(groupColRef.current && groupColRef.current.querySelector('.sel'));
      scrollIntoMiddle(chanColRef.current && chanColRef.current.querySelector('.sel'));
    } else if (mode === 'settings') {
      scrollIntoMiddle(setColRef.current && setColRef.current.querySelector('.sel'));
    }
  }, [mode, list, setIdx]);

  const lineText = pstate.lines > 1 ? '线路 ' + pstate.line + '/' + pstate.lines : pstate.lines === 1 ? '1 条线路' : '';
  const busy = pstate.status && pstate.status !== 'playing' && pstate.status !== 'idle';
  const curGroup = groups[list.g];

  return (
    <div className={'app mode-' + mode}>
      <video ref={videoRef} className="video" autoPlay playsInline />

      {loadStatus === 'loading' && !cur && <div className="center-msg">正在加载直播源…</div>}
      {loadStatus === 'failed' && !cur && (
        <div className="center-msg">直播源加载失败<small>请检查网络，或按 OK → 设置 更换直播源</small></div>
      )}
      {busy && cur && mode === 'tv' && (
        <div className={'center-msg' + (pstate.status === 'failed' ? ' failed' : '')}>
          {STATUS_TEXT[pstate.status] || ''}
          {pstate.status === 'failed' && <small>按 ← → 手动换线路，▶ 重试，OK 选台</small>}
        </div>
      )}

      {cur && (banner || busy) && mode === 'tv' && (
        <div className="banner">
          <div className="banner-num">{cur.num}</div>
          {cur.logo ? <img className="banner-logo" src={cur.logo} alt="" onError={e => { e.target.style.display = 'none'; }} /> : null}
          <div className="banner-main">
            <div className="banner-name">{cur.name}{favs.indexOf(cur.key) >= 0 ? <span className="star">★</span> : null}</div>
            <div className="banner-sub">{cur.group}{lineText ? ' · ' + lineText : ''}{pstate.error && busy ? ' · ' + pstate.error : ''}</div>
          </div>
          <div className="banner-hint">↑↓ 换台 · ←→ 换线路 · OK 频道列表</div>
        </div>
      )}

      {digits && <div className="digits">{digits}</div>}

      {mode === 'list' && (
        <div className="panel list">
          <div className="col groups" ref={groupColRef}>
            {groups.map((g, i) => (
              <div key={g.name} className={'row' + (i === list.g ? (list.col === 'group' ? ' sel' : ' sel dim') : '')}>
                {g.name}{g.channels.length ? <span className="count">{g.channels.length}</span> : null}
              </div>
            ))}
          </div>
          <div className="col chans" ref={chanColRef}>
            {curGroup && curGroup.name === SETTINGS_GROUP && <div className="row hint">按 OK 打开设置</div>}
            {curGroup && curGroup.channels.map((ch, i) => (
              <div key={ch.key} className={'row ch' + (i === list.c && list.col === 'channel' ? ' sel' : '') + (cur && ch.key === cur.key ? ' playing' : '')}>
                <span className="num">{ch.num}</span>
                <span className="name">{ch.name}</span>
                {favs.indexOf(ch.key) >= 0 && <span className="star">★</span>}
                <span className="lines">{ch.urls.length}</span>
              </div>
            ))}
          </div>
          <div className="foot">↑↓ 选择 · ← 分组 · → 收藏 · OK 播放 · 返回 关闭</div>
        </div>
      )}

      {mode === 'settings' && (
        <div className="panel settings">
          <div className="title">设置 <small>直播源来自 youhunwl/TVAPP · v{VERSION}</small></div>
          <div className="col setrows" ref={setColRef}>
            {settingRows.map((r, i) => (
              <div key={i} className={'row' + (i === setIdx ? ' sel' : '')}>
                {r.on != null && <span className={'check' + (r.on ? ' on' : '')}>{r.on ? '✓' : ''}</span>}
                <span className="name">{r.label}</span>
                {r.hint && <span className="hint">{r.hint}</span>}
              </div>
            ))}
          </div>
          {lastStatus && (
            <div className="srcstatus">
              {lastStatus.map(s => (
                <div key={s.name}>{s.ok ? '✅' : s.fromCache ? '⚠️' : '❌'} {s.name}：{s.ok ? s.count + ' 条' : (s.fromCache ? '使用缓存 · ' : '') + s.error}</div>
              ))}
            </div>
          )}
          <div className="foot">↑↓ 选择 · OK 开关 · 返回 保存并关闭</div>
          {adding && <AddSource onDone={addCustom} />}
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function AddSource({ onDone }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.focus(); }, []);
  return (
    <div className="add-source">
      <div>输入 M3U / TXT 直播源地址，按 OK 确定</div>
      <input ref={ref} type="url" defaultValue="https://"
        onKeyDown={e => { if (e.keyCode === 13 || e.keyCode === 65376) { e.preventDefault(); onDone(e.target.value); } }} />
    </div>
  );
}

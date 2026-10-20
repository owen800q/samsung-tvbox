// localStorage with a `tvbox_` prefix and JSON values. Every access is
// guarded: storage can be full (cached playlists are large) or unavailable.
const PREFIX = 'tvbox_';

export function get(key, def) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? def : JSON.parse(v);
  } catch (e) {
    return def;
  }
}

export function set(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch (e) { /* ignore */ }
}

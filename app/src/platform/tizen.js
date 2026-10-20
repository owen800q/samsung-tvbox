// Samsung Tizen TV glue: remote keys and leaving the app.

export const KEY = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
  BACK: 10009, BACK_WEBOS: 461, ESC: 27,
  CH_UP: 427, CH_DOWN: 428, CH_LIST: 10073, INFO: 457,
  PLAY_PAUSE: 10252, PLAY: 415, PAUSE: 19, STOP: 413,
  RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406,
  PAGE_UP: 33, PAGE_DOWN: 34,
};

// Keys an app must register before Tizen delivers them. Arrows, Enter and
// Back are always delivered. The Samsung Smart Remote has no number or colour
// keys, so everything also works with arrows, OK and Back alone.
const REGISTERED_KEYS = [
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'ChannelUp', 'ChannelDown', 'ChannelList', 'Info',
  'MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop',
  'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue',
];

export function isTizen() {
  return typeof window !== 'undefined' && typeof window.tizen !== 'undefined';
}

export function isBack(e) {
  return e.keyCode === KEY.BACK || e.keyCode === KEY.BACK_WEBOS || e.keyCode === KEY.ESC || e.key === 'XF86Back' || e.key === 'Escape';
}

// 0–9 from the number row or the number pad (codes 48–57 / 96–105).
export function digitOf(e) {
  if (e.keyCode >= 48 && e.keyCode <= 57) return e.keyCode - 48;
  if (e.keyCode >= 96 && e.keyCode <= 105) return e.keyCode - 96;
  return -1;
}

export function initPlatform() {
  const input = isTizen() && window.tizen.tvinputdevice;
  if (!input) return;
  REGISTERED_KEYS.forEach(name => {
    try { input.registerKey(name); } catch (e) { /* not on this remote */ }
  });
}

export function exitApp() {
  try {
    if (isTizen()) { window.tizen.application.getCurrentApplication().exit(); return; }
  } catch (e) { /* fall through */ }
  try { window.close(); } catch (e) { /* ignore */ }
}

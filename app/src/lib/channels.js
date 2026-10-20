// Turn raw playlist entries (from several subscriptions) into the TV's lineup:
// one channel per canonical name with every URL found for it ("lines"),
// sorted into groups — 央视, 卫视, 港澳台, provinces (广东 first), then the rest.

const CCTV_TITLES = {
  '1': '综合', '2': '财经', '3': '综艺', '4': '中文国际', '5': '体育', '5+': '体育赛事',
  '6': '电影', '7': '国防军事', '8': '电视剧', '9': '纪录', '10': '科教', '11': '戏曲',
  '12': '社会与法', '13': '新闻', '14': '少儿', '15': '音乐', '16': '奥林匹克', '17': '农业农村',
  '4K': '超高清', '8K': '超高清',
};
const CCTV_ORDER = ['1', '2', '3', '4', '5', '5+', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17', '4K', '8K'];

// 卫视 in the order most viewers look for them.
const WEISHI_ORDER = ['湖南', '浙江', '东方', '江苏', '北京', '广东', '深圳', '大湾区', '天津', '山东', '安徽', '湖北', '四川', '重庆',
  '东南', '江西', '河南', '河北', '广西', '辽宁', '黑龙江', '吉林', '贵州', '云南', '山西', '陕西', '甘肃', '青海', '宁夏',
  '新疆', '西藏', '内蒙古', '海南', '兵团', '三沙', '厦门', '康巴', '延边', '农林'];

export const PROVINCES = ['广东', '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林', '黑龙江', '江苏', '浙江', '安徽',
  '福建', '江西', '山东', '河南', '湖北', '湖南', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海', '内蒙古', '广西',
  '西藏', '宁夏', '新疆'];
// Local stations whose names start with a city rather than the province.
const CITY_PROVINCE = {
  '广州': '广东', '深圳': '广东', '佛山': '广东', '东莞': '广东', '珠海': '广东', '汕头': '广东', '惠州': '广东',
  '中山': '广东', '江门': '广东', '珠江': '广东', '南方': '广东', '岭南': '广东', '嘉佳': '广东',
  '杭州': '浙江', '宁波': '浙江', '温州': '浙江', '南京': '江苏', '苏州': '江苏', '无锡': '江苏',
  '长沙': '湖南', '金鹰': '湖南', '武汉': '湖北', '成都': '四川', '厦门': '福建', '福州': '福建',
  '济南': '山东', '青岛': '山东', '郑州': '河南', '西安': '陕西', '昆明': '云南', '南宁': '广西',
};
const HMT_RE = /凤凰|翡翠|TVB|明珠台|VIUTV|香港|澳门|澳视|澳亚|台视|中视|华视|民视|东森|中天|三立|TVBS|HOY|RTHK|有线|无线|八大|纬来|年代|寰宇|星空|ATV|NOW|J2/i;
const KEEP_GROUP_RE = /直播中国|风景|景区|春晚|电影|影院|剧场|电视剧|纪录|儿童|少儿|动画|卡通|体育|赛事|音乐|解说/;
const JUNK_GROUP_RE = /更新|公告|关于|说明|免责|声明|赞助|公众号/;
const JUNK_NAME_RE = /更新时间|关于本源|公众号|^\d{4}[-/.]?\d{2}[-/.]?\d{2}/;

export const GROUP_FAV = '收藏';
const FIXED_GROUPS = ['央视', '卫视', '港澳台'];

// "CCTV-1 综合 HD" → CCTV1, "广东卫视[高清]" → 广东卫视, "湖南卫视 4K" stays separate.
export function canonical(name) {
  let n = String(name || '').trim()
    .replace(/[（(\[【][^)）\]】]*[)）\]】]/g, '')
    .replace(/＋/g, '+')
    .replace(/[\s_·•|]+/g, '')
    .toUpperCase();
  n = n.replace(/(超高清|高清|超清|标清|蓝光|FHD|UHD|HD|1080P|720P|HEVC|H265|H264|IPV4|IPV6|频道)+$/g, '');
  const m = n.match(/^CCTV-?(\d{1,2}\+?|4K|8K)(.*)$/);
  if (m) {
    const num = m[1];
    let rest = m[2].replace(/^-/, '');
    const title = CCTV_TITLES[num];
    if (title && rest.startsWith(title)) rest = rest.slice(title.length);
    rest = rest.replace(/(超高清|高清|超清|频道|PLUS)+$/g, '');
    if (num === '5' && rest === '+') return 'CCTV5+';
    return 'CCTV' + num + rest;
  }
  return n.replace(/-/g, '');
}

export function displayName(key) {
  const m = key.match(/^CCTV(\d{1,2}\+?|4K|8K)$/);
  if (m && CCTV_TITLES[m[1]]) return 'CCTV-' + m[1] + ' ' + CCTV_TITLES[m[1]];
  return key;
}

function provinceOf(text) {
  for (const p of PROVINCES) if (text.startsWith(p)) return p;
  for (const c in CITY_PROVINCE) if (text.startsWith(c)) return CITY_PROVINCE[c];
  return '';
}

// Strip emoji and decorations: "📺央视频道" → "央视", "☘️广东频道" → "广东".
export function cleanGroup(g) {
  return String(g || '')
    .replace(/[\u{1F000}-\u{1FAFF}☀-➿️‍]/gu, '')
    .replace(/[·•\s]/g, '')
    .replace(/(频道|节目|直播)$/, '')
    .trim();
}

export function classify(key, sourceGroup) {
  if (/^(CCTV|CGTN|央视)/.test(key)) return '央视';
  const g = cleanGroup(sourceGroup);
  const keyProvince = provinceOf(key);
  if (HMT_RE.test(key) && !keyProvince) return '港澳台';
  if (/卫视$/.test(key)) return '卫视';
  if (/港|澳|台湾/.test(g)) return '港澳台';
  // Themed groups (webcams, films, gala reruns…) stay together even when a
  // channel is named after a province.
  if (KEEP_GROUP_RE.test(g)) return g;
  const p = keyProvince || provinceOf(g);
  if (p) return p;
  if (/央视|CCTV/i.test(g)) return '央视';
  if (/卫视/.test(g)) return '卫视';
  return g || '其他';
}

// Stand-in clips: .mp4 files, and short-video CDNs (Kuaishou, Douyin) whose
// HLS links are recordings, not live channels.
const CLIP_HOST_RE = /^https?:\/\/[^/]*(kwimgs\.com|kwai|douyin|iesdouyin|douyinvod|gitlab\.com)[/:]/i;
export function isClip(u) {
  return /\.mp4(\?|$)/i.test(u) || CLIP_HOST_RE.test(u);
}

function isIpv6Url(u) {
  return /^https?:\/\/\[/i.test(u);
}

// Lines in the order the player tries them, without duplicates. Lists often
// stand in a clip ("source expired" notice, a recording) for a live channel.
export function rankUrls(urls, { ipv6 = false } = {}) {
  const seen = new Set();
  const live = [];
  const clips = [];
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
    if (!ipv6 && isIpv6Url(u)) continue;
    seen.add(u);
    (isClip(u) ? clips : live).push(u);
  }
  // A channel with any live line drops its clips: playing a recording under a
  // live channel's name is worse than saying the channel can't be played.
  return live.length ? live : clips;
}

function weishiRank(key) {
  const i = WEISHI_ORDER.findIndex(p => key.startsWith(p));
  return i < 0 ? 999 : i;
}

function cctvRank(key) {
  const m = key.match(/^CCTV(\d{1,2}\+?|4K|8K)$/);
  if (m) { const i = CCTV_ORDER.indexOf(m[1]); if (i >= 0) return i; }
  if (/^CCTV\d/.test(key)) return 100;
  if (/^CGTN/.test(key)) return 200;
  return 300;
}

function groupRank(name) {
  const f = FIXED_GROUPS.indexOf(name);
  if (f >= 0) return f;
  const p = PROVINCES.indexOf(name);
  if (p >= 0) return 10 + p;
  return 100;
}

// lists: arrays of entries from parsePlaylist, in subscription order.
export function buildLineup(lists, opts = {}) {
  const byKey = new Map();
  let seq = 0;
  for (const entries of lists) {
    for (const e of entries) {
      if (JUNK_GROUP_RE.test(e.group) || JUNK_NAME_RE.test(e.name)) continue;
      const key = canonical(e.name);
      if (!key) continue;
      let ch = byKey.get(key);
      if (!ch) {
        ch = { key, name: displayName(key), group: classify(key, e.group), logo: '', urls: [], seq: seq++ };
        byKey.set(key, ch);
      }
      if (!ch.logo && e.logo) ch.logo = e.logo;
      ch.urls.push(e.url);
    }
  }
  const groups = new Map();
  for (const ch of byKey.values()) {
    ch.urls = rankUrls(ch.urls, opts);
    if (!ch.urls.length) continue;
    if (!groups.has(ch.group)) groups.set(ch.group, []);
    groups.get(ch.group).push(ch);
  }
  const ordered = [...groups.entries()]
    .map(([name, channels]) => {
      if (name === '央视') channels.sort((a, b) => cctvRank(a.key) - cctvRank(b.key) || a.seq - b.seq);
      else if (name === '卫视') channels.sort((a, b) => weishiRank(a.key) - weishiRank(b.key) || a.seq - b.seq);
      else channels.sort((a, b) => a.seq - b.seq);
      return { name, channels };
    })
    .sort((a, b) => groupRank(a.name) - groupRank(b.name) || b.channels.length - a.channels.length);
  const channels = [];
  for (const g of ordered) for (const ch of g.channels) { ch.num = channels.length + 1; delete ch.seq; channels.push(ch); }
  return { groups: ordered, channels };
}

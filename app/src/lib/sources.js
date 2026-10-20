// Live-source subscriptions, from the 直播源 list in youhunwl/TVAPP
// (https://github.com/youhunwl/TVAPP#直播源-). The ones marked `on` are enabled
// on first launch; the rest can be switched on in 设置 → 直播源.
// Users can also add their own M3U/TXT URL.

export const SOURCES = [
  { id: 'guovin-v4', name: 'IPTV-API IPv4 (Guovin)', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/ipv4/result.m3u', on: true },
  { id: 'zbds-v4', name: '直播电视 IPv4 (zbds)', url: 'https://live.zbds.top/tv/iptv4.m3u', on: true },
  { id: 'burningc4', name: 'BurningC4 IPv4', url: 'https://raw.githubusercontent.com/BurningC4/Chinese-IPTV/master/TV-IPV4.m3u', on: true },
  { id: 'myiptv-v4', name: 'myIPTV IPv4', url: 'https://raw.githubusercontent.com/suxuang/myIPTV/refs/heads/main/ipv4.m3u' },
  { id: 'kimentanm', name: 'Kimentanm (部分 IPv6)', url: 'https://raw.githubusercontent.com/Kimentanm/aptv/master/m3u/iptv.m3u' },
  { id: 'guovin', name: 'IPTV-API 默认 (Guovin)', url: 'https://raw.githubusercontent.com/Guovin/iptv-api/gd/output/result.m3u' },
  { id: 'chake', name: '茶客源', url: 'https://raw.githubusercontent.com/vamoschuck/TV/main/M3U' },
  { id: 'yang', name: 'YanG 集合源', url: 'https://raw.githubusercontent.com/YanG-1989/m3u/main/Gather.m3u' },
  { id: 'bigbiggrandg', name: 'BigBigGrandG 集合源', url: 'https://raw.githubusercontent.com/BigBigGrandG/IPTV-URL/release/Gather.m3u' },
  { id: 'fanmingming-v6', name: '范明明 IPv6', url: 'https://live.fanmingming.cn/tv/m3u/ipv6.m3u', ipv6: true },
  { id: 'zbds-v6', name: '直播电视 IPv6 (zbds)', url: 'https://live.zbds.top/tv/iptv6.m3u', ipv6: true },
  { id: 'yuechan-v6', name: 'YueChan IPv6', url: 'https://raw.githubusercontent.com/YueChan/Live/main/IPTV.m3u', ipv6: true },
  { id: 'epg-cn', name: 'epg.pw 中国大陆', url: 'https://epg.pw/test_channels.m3u' },
  { id: 'epg-hk', name: 'epg.pw 香港', url: 'https://epg.pw/test_channels_hong_kong.m3u' },
  { id: 'iptv-org-cn', name: 'iptv-org 中国', url: 'https://iptv-org.github.io/iptv/countries/cn.m3u' },
];

// GitHub raw is slow or blocked from some networks; TVAPP suggests adding a
// proxy in front. These are tried in turn after the direct URL fails.
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/'];

export function candidateUrls(url) {
  if (!/^https:\/\/(raw\.githubusercontent\.com|github\.com)\//.test(url)) return [url];
  return [url].concat(GH_MIRRORS.map(m => m + url));
}

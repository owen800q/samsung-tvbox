import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, displayName, classify, cleanGroup, rankUrls, buildLineup } from './channels.js';

test('canonical names merge spelling variants', () => {
  for (const n of ['CCTV-1', 'CCTV1', 'CCTV-1 综合', 'CCTV1综合', 'cctv1 HD', 'CCTV-1高清', 'CCTV1[1080P]']) assert.equal(canonical(n), 'CCTV1', n);
  assert.equal(canonical('CCTV-5+'), 'CCTV5+');
  assert.equal(canonical('CCTV5+体育赛事'), 'CCTV5+');
  assert.equal(canonical('CCTV-4K'), 'CCTV4K');
  assert.equal(canonical('CCTV4欧洲'), 'CCTV4欧洲');
  assert.equal(canonical('CCTV-13 新闻'), 'CCTV13');
  assert.equal(canonical('湖南卫视 HD'), '湖南卫视');
  assert.equal(canonical('广东卫视[高清]'), '广东卫视');
  assert.equal(canonical('广东卫视4K'), '广东卫视4K');
  assert.equal(canonical('广东 珠江'), '广东珠江');
});

test('display names for CCTV', () => {
  assert.equal(displayName('CCTV1'), 'CCTV-1 综合');
  assert.equal(displayName('CCTV5+'), 'CCTV-5+ 体育赛事');
  assert.equal(displayName('湖南卫视'), '湖南卫视');
});

test('groups', () => {
  assert.equal(cleanGroup('📺央视频道'), '央视');
  assert.equal(cleanGroup('☘️广东频道'), '广东');
  assert.equal(cleanGroup('🌊港·澳·台'), '港澳台');
  assert.equal(classify('CCTV1', '地方'), '央视');
  assert.equal(classify('湖南卫视', '港澳台频道'), '卫视');
  assert.equal(classify('广东珠江', '地方频道'), '广东');
  assert.equal(classify('深圳都市', ''), '广东');
  assert.equal(classify('嘉佳卡通', ''), '广东');
  assert.equal(classify('翡翠台', ''), '港澳台');
  assert.equal(classify('凤凰卫视中文台', '卫视'), '港澳台');
  assert.equal(classify('某某台', '☘️广东频道'), '广东');
  assert.equal(classify('电影1', '🎬电影频道'), '电影');
  assert.equal(classify('X', ''), '其他');
});

test('rankUrls: dedupe, IPv6 off by default, clips only when nothing else', () => {
  const urls = ['http://a/x.mp4', 'http://b/1.m3u8', 'http://[2409::1]/1.m3u8', 'http://b/1.m3u8', 'rtmp://c', 'https://d/2.m3u8?k=1'];
  assert.deepEqual(rankUrls(urls), ['http://b/1.m3u8', 'https://d/2.m3u8?k=1']);
  assert.deepEqual(rankUrls(['http://a/x.mp4']), ['http://a/x.mp4']);
  assert.deepEqual(rankUrls(urls, { ipv6: true })[1], 'http://[2409::1]/1.m3u8');
  assert.deepEqual(rankUrls(['https://txmov2.a.kwimgs.com/bs3/video-hls/1_hlsb.m3u8', 'http://x/hn.m3u8']), ['http://x/hn.m3u8']);
});

test('buildLineup merges sources, orders groups and numbers channels', () => {
  const a = [
    { name: '更新时间', group: '🕘️更新时间', url: 'http://t/x.mp4', logo: '' },
    { name: 'CCTV-1', group: '央视频道', url: 'https://txmov2.a.kwimgs.com/clip.m3u8', logo: '' },
    { name: '湖南卫视', group: '卫视频道', url: 'http://a/hn.m3u8', logo: '' },
    { name: 'CCTV-13', group: '央视频道', url: 'http://a/13.m3u8', logo: 'L13' },
    { name: '广东珠江', group: '地方频道', url: 'http://a/zj.m3u8', logo: '' },
    { name: '天津卫视', group: '卫视频道', url: 'http://a/tj.m3u8', logo: '' },
    { name: 'CCTV-1', group: '央视频道', url: 'http://a/1.m3u8', logo: '' },
  ];
  const b = [
    { name: 'CCTV1综合', group: '央视', url: 'http://b/1.m3u8', logo: 'L1' },
    { name: '广东卫视', group: '卫视', url: 'http://b/gd.m3u8', logo: '' },
    { name: '电影X', group: '电影', url: 'http://b/m.m3u8', logo: '' },
  ];
  const { groups, channels } = buildLineup([a, b]);
  assert.deepEqual(groups.map(g => g.name), ['央视', '卫视', '广东', '电影']);
  assert.deepEqual(groups[0].channels.map(c => c.name), ['CCTV-1 综合', 'CCTV-13 新闻']);
  assert.deepEqual(groups[1].channels.map(c => c.key), ['湖南卫视', '广东卫视', '天津卫视']);
  const c1 = channels[0];
  assert.deepEqual(c1.urls, ['http://a/1.m3u8', 'http://b/1.m3u8']);
  assert.equal(c1.logo, 'L1');
  assert.deepEqual(channels.map(c => c.num), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(!channels.some(c => /更新/.test(c.name)));
});

test('themed groups keep province-named channels', () => {
  assert.equal(classify('四川峨眉山云海日出', '直播中国'), '直播中国');
  assert.equal(classify('福建漳州醉美沙滩翡翠湾', '直播中国'), '直播中国');
  assert.equal(classify('福建漳州翡翠湾', ''), '福建');
  assert.equal(classify('广东体育', '体育频道'), '体育');
});

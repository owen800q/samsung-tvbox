// Assemble the Tizen widget from the Vite build (app/dist) and sign it when the
// Tizen CLI is available.
//   cd app && npm run package [-- --profile <security-profile>]
// The widget version comes from app/src/version.js (APP_VERSION); TV_VERSION
// overrides it (the release workflow sets it).
// The widget starts through the over-the-air loader (ota/): the build sits under
// app/, and newer builds come from the repository's latest GitHub release.
//   OTA=0               package without updates
//   OTA_MANIFEST=<url>  check another manifest (testing)
import { cpSync, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeWidget, MANIFEST_URL } from '../ota/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'app', 'dist');
const out = join(root, 'build');
const stage = join(out, 'widget');
const profileArg = process.argv.indexOf('--profile');
const profile = profileArg > 0 ? process.argv[profileArg + 1] : process.env.TIZEN_PROFILE;

if (!existsSync(join(dist, 'index.html'))) throw new Error('app/dist is missing: run `npm run build` in app/ first');
const versionSrc = readFileSync(join(root, 'app', 'src', 'version.js'), 'utf8');
const version = process.env.TV_VERSION || (versionSrc.match(/APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
if (!version) throw new Error('APP_VERSION not found in app/src/version.js');

const manifest = process.env.OTA === '0' ? null : (process.env.OTA_MANIFEST || MANIFEST_URL);
rmSync(stage, { recursive: true, force: true });
for (const f of existsSync(out) ? readdirSync(out) : []) if (f.endsWith('.wgt')) rmSync(join(out, f));
mkdirSync(stage, { recursive: true });
const id = await writeWidget({
  dir: dist, html: readFileSync(join(dist, 'index.html'), 'utf8'), stage, key: 'tvbox', version, manifest,
  text: '新版本已下载，下次打开时生效', updated: '已更新到新版本', check: '#root',
});
const config = readFileSync(join(root, 'tizen', 'config.xml'), 'utf8')
  .replace(/(<widget[^>]*\sversion=")[^"]*"/, `$1${version}"`);
writeFileSync(join(stage, 'config.xml'), config);
cpSync(join(root, 'tizen', 'icon.png'), join(stage, 'icon.png'));

function tizenCli() {
  const candidates = ['tizen', join(process.env.TIZEN_HOME || join(process.env.HOME || '', 'tizen-studio'), 'tools', 'ide', 'bin', 'tizen')];
  for (const bin of candidates) {
    try { execFileSync(bin, ['version'], { stdio: 'ignore' }); return bin; } catch (_) { /* next */ }
  }
  return null;
}

const tizen = tizenCli();
if (tizen) {
  const args = ['package', '-t', 'wgt', '-o', out];
  if (profile) args.push('-s', profile);
  args.push('--', stage);
  execFileSync(tizen, args, { stdio: 'inherit' });
  // `tizen package` names the file after <name>, which is Chinese; sdb can't
  // push non-ASCII file names.
  const built = readdirSync(out).find(f => f.endsWith('.wgt'));
  if (built && built !== 'TVBoxLive.wgt') renameSync(join(out, built), join(out, 'TVBoxLive.wgt'));
  console.log(`Widget written to build/TVBoxLive.wgt (v${version}, build ${id}${profile ? ', signed with ' + profile : ', unsigned'})${manifest ? '' : ', updates off'}`);
} else {
  const target = join(out, 'TVBoxLive-unsigned.wgt');
  execFileSync('zip', ['-qr', target, '.'], { cwd: stage });
  console.log(`Tizen CLI not found. Unsigned widget: build/TVBoxLive-unsigned.wgt (v${version}, build ${id})${manifest ? '' : ', updates off'}`);
  console.log('A TV only installs signed widgets: see README "Build and install".');
}

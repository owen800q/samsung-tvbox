// Write the over-the-air release assets for the current app build (app/dist):
//   build/release/ota-manifest.json   checked by TVs at releases/latest/download/
//   build/release/ota-<id>.json       the whole build, downloaded when the id is new
// RELEASE_TAG: the tag the assets are uploaded to (the bundle URL points there).
// OTA_BASE_URL: serve the bundle from elsewhere instead (testing).
// TV_VERSION: the version shown on the TV (default: APP_VERSION).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeRelease, REPO } from '../ota/build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'app', 'dist');
const versionSrc = readFileSync(join(root, 'app', 'src', 'version.js'), 'utf8');
const version = process.env.TV_VERSION || (versionSrc.match(/APP_VERSION\s*=\s*'([\d.]+)'/) || [])[1];
const tag = process.env.RELEASE_TAG;
const base = process.env.OTA_BASE_URL;
if (!tag && !base) throw new Error('Set RELEASE_TAG (or OTA_BASE_URL for testing)');
const bundleUrl = (id, name) => (base ? base.replace(/\/?$/, '/') + name : `https://github.com/${REPO}/releases/download/${tag}/${name}`);
const { id, name, manifest } = await writeRelease({ dir: dist, html: readFileSync(join(dist, 'index.html'), 'utf8'), out: join(root, 'build', 'release'), version, bundleUrl });
console.log(`OTA build ${id} (v${version}): build/release/ota-manifest.json, build/release/${name} (${manifest.size} bytes)`);

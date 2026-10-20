# Over-the-air updates from GitHub Releases

The packaged widget updates itself from this repository's releases, so a fix reaches installed TVs without reinstalling the widget. There is no server to run: every push to `main` publishes a release, and TVs check the latest one.

## How it works

- **The release** (`.github/workflows/release.yml`, `scripts/ota-release.mjs`): every push to `main` builds the app and publishes release `v<major>.<minor>.<run>` with three assets:
  - `TVBoxLive.wgt`: the widget, for a first install.
  - `ota-manifest.json`: `{ id, version, bundle, size }`.
  - `ota-<id>.json`: the whole build (page markup and every file) in one document.

  A build's id is a hash of its files and page markup. A push that doesn't change the app (docs, tools) publishes the same id, so TVs don't download anything.
- **The widget** (`writeWidget` in `build.mjs`): `index.html` is a small loader (`ota.js` plus a generated `ota-config.js`), and the app build sits under `app/`.
- **On the TV** (`ota.js`):
  1. The app starts at once from the newest build already on the TV: either `app/` or a build downloaded earlier. Nothing waits on the network.
  2. Ten seconds after the page has loaded, and again when the app returns to the foreground after 3 hours or more, the loader fetches `https://github.com/owen800q/samsung-tvbox/releases/latest/download/ota-manifest.json`. It never does this while a video is playing. 设置 → 检查更新 checks at once.
  3. If the manifest names a different build, the loader downloads `ota-<id>.json` (about 0.9 MB), checks every file's length, and stores it in IndexedDB. A notice says the update applies at the next launch. In 设置 the row becomes 立即重启, which restarts into it.
  4. The next launch runs the downloaded build and says once that the app was updated.

### Why the build is stored, not run from GitHub

GitHub serves release assets as `application/octet-stream`, with no CORS headers and no long-lived caching, so the browser won't run them as scripts. The loader keeps the build in IndexedDB instead. At launch it turns each file into a `blob:` URL and inserts the page's scripts in order. It also points SystemJS (the module loader in the legacy bundle) at those blobs: the `resolve` hook maps `./assets/x.js` to its blob, and `createScript` drops `crossorigin` for blobs. Lazy chunks such as hls.js therefore load from storage too.

## Safety

- **Stored build missing** (storage cleared): the loader starts the bundled build and downloads again at the next check.
- **Broken build:** a downloaded build falls back to the bundled one and is marked bad when:
  - one of its scripts fails to load;
  - SystemJS can't load one of its modules;
  - `#root` is still empty 10 seconds after start;
  - it fails three launches in a row (the app closes within 5 seconds of loading).

  A bad build is tried again after a day, or by 检查更新, or when a newer push publishes a different build.
- **Rollback:** delete the newest release on GitHub, or mark an older release as "latest". TVs follow whatever the latest manifest names. When it names the build inside the widget, they drop the downloaded one.
- **A broken build can still be replaced:** the update check runs in the loader, not in the app, so the next push reaches TVs even when the current build's app code is broken.

## When a reinstall is still needed

Only for changes outside the app build: `tizen/config.xml` (privileges, CSP, version, app id), the icon, or this loader. Use `TVBoxLive.wgt` from the latest release, or `scripts/tv.sh`.

The release widget is signed when the repository has these secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
|-|-|
| `TIZEN_AUTHOR_P12` | `base64 -i ~/SamsungCertificate/<profile>/author.p12` |
| `TIZEN_AUTHOR_PASSWORD` | the author certificate password |
| `TIZEN_DISTRIBUTOR_P12` | `base64 -i ~/SamsungCertificate/<profile>/distributor.p12` |
| `TIZEN_DISTRIBUTOR_PASSWORD` | the distributor certificate password |

Without them the release carries an unsigned widget, which a TV will not install. Updates still work: the downloaded build isn't a widget and needs no signature.

## Options

- `OTA=0 npm run package`: a widget without updates.
- `OTA_MANIFEST=<url> npm run package`: check another manifest (testing).
- `OTA_BASE_URL=<url> RELEASE_TAG= node scripts/ota-release.mjs`: write the release assets with the bundle at another URL (testing).

## Testing

`npm test` runs the loader in a VM with fake IndexedDB, DOM and network: choosing the build, running it through blobs, the SystemJS mapping, falling back, checking and downloading, rollback. It also checks that the loader stays ES5.

End-to-end in the Samsung TV Web Simulator, with a local web server in place of GitHub (2026-10-20):
1. Widget 1.0.1 started from its bundled build.
2. 设置 → 检查更新 downloaded build 1.0.2 (913 KB), and the row turned into 立即重启.
3. OK restarted into 1.0.2, which ran from IndexedDB. CCTV-13 played at 1920×1080 through hls.js, loaded as a lazy chunk from storage.
4. A build corrupted in storage fell back to 1.0.1 within 10 s ("nothing drawn in #root") and was marked bad. A build deleted from storage fell back to 1.0.1 without being marked bad.

An XHR from the simulator followed GitHub's `releases/download/…` redirect to `release-assets.githubusercontent.com`.

**Not verified:** whether the TV's web runtime lets the packaged app read GitHub release assets without CORS headers. The simulator runs with web security off. Tizen grants network access through `<access origin="*">` in `config.xml`, and the app's playlist and line checks rely on the same thing. If a TV refused it, 检查更新 would report 检查更新失败, and the app would keep running its installed build.

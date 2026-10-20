# samsung-tvbox

Live TV for Samsung Tizen TVs, playing the IPTV lists from youhunwl/TVAPP. See README.md.

- Tests: `npm test` at the repo root. Run them before every push.
- `npm run check:streams` shows which lines answer from the current network. Cloud sandboxes often reach only ports 80/443, so most mainland IP:port lines fail there; say so instead of reporting a channel as broken.
- Simulator smoke test: see README "Testing". Wipe `~/.config/tizen tv web simulator` before launching, or the simulator may come up on its home screen instead of the app. A WARN (HEVC line, or every line timed out) is a limit of the simulator or the network, not a pass: report it as unverified.
- Keep storage keys under the `tvbox_` prefix (`app/src/lib/storage.js`); saved favourites, subscriptions and the last channel must survive updates.
- Don't put streams or private URLs in the repo: the app fetches public lists at runtime.
- Every push to `main` publishes a GitHub release, and installed TVs download its build (ota/README.md). A broken build reaches TVs at their next check: run the tests and the simulator smoke test first. Keep `ota/ota.js` ES5 (Tizen 4.0), and remember a change to it, `tizen/config.xml` or the icon needs a reinstall.
- Don't commit the `build/` output.
- The relay (`relay/server.mjs`) runs on the maintainer's server; changing it doesn't update that server, so say so in the PR. Its address is private: never put a relay URL in this public repo, its tests or builds. The TV keeps it in `tvbox_relay` only.

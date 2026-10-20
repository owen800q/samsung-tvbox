#!/usr/bin/env bash
# Build, sign, install and launch the app on a Samsung TV in Developer mode.
# Usage: scripts/tv.sh <tv-ip> <samsung-security-profile>
# The profile's distributor certificate must list the TV's DUID, and the TV's
# Developer mode must have this computer's IP set.
set -euo pipefail
TV_IP="${1:?usage: scripts/tv.sh <tv-ip> <profile>}"
PROFILE="${2:?usage: scripts/tv.sh <tv-ip> <profile>}"
TIZEN_HOME="${TIZEN_HOME:-$HOME/tizen-studio}"
export PATH="$TIZEN_HOME/tools/ide/bin:$TIZEN_HOME/tools:$PATH"
APP_ID="TVBoxLive0.TVBoxLive"
cd "$(dirname "$0")/.."

sdb connect "$TV_IP" >/dev/null
TARGET="$(sdb devices | awk -v ip="$TV_IP" 'index($1, ip ":") == 1 && $2 == "device" {print $3; exit}')"
[ -n "$TARGET" ] || { echo "TV $TV_IP not connected. Is Developer mode on and the TV awake?" >&2; exit 1; }

(cd app && npm install --no-audit --no-fund && npm run package -- --profile "$PROFILE")
OUT="$(tizen install -n build/TVBoxLive.wgt -t "$TARGET" 2>&1 || true)"
echo "$OUT"
echo "$OUT" | grep -q "successfully installed" \
  || { echo "Install failed. Wrong profile? Check the TV's DUID is in '$PROFILE'." >&2; exit 1; }
tizen run -p "$APP_ID" -t "$TARGET"
echo "Running on $TARGET ($TV_IP)."

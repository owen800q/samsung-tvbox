#!/usr/bin/env bash
# Install or update the samsung-tvbox HLS relay as a systemd service.
#
#   curl -fsSL https://raw.githubusercontent.com/owen800q/samsung-tvbox/main/relay/setup.sh | sudo bash
#   sudo bash setup.sh [options]
#
# Options:
#   --port N            port to listen on (default 9997)
#   --secret S          URL secret (default: keep the installed one, or make a new one)
#   --cert F --key F    certificate and key (PEM) to serve HTTPS with
#   --tls-from SERVICE  reuse the certificate of another systemd service (default: bili-relay, if present)
#   --no-tls            plain HTTP (not for use across China's border)
#   --file F            install this server.mjs instead of downloading it
#   --ref R             git branch or tag to download from (default main)
#   --uninstall         remove the service, timer and files
#   --dry-run           print what would be written, change nothing
#
# Re-running updates server.mjs and keeps the port and secret. The relay reads
# its certificate through systemd credentials; an hourly timer restarts it when
# the certificate file changes (renewals), so nothing else needs editing.
set -euo pipefail

NAME=tvbox-relay
REPO=owen800q/samsung-tvbox
DIR=${TVBOX_RELAY_DIR:-/opt/tvbox-relay}
UNIT_DIR=${TVBOX_UNIT_DIR:-/etc/systemd/system}
PORT=9997
SECRET=
CERT=
KEY=
TLS_FROM=
NO_TLS=0
FILE=
REF=main
UNINSTALL=0
DRY=0

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --secret) SECRET=$2; shift 2 ;;
    --cert) CERT=$2; shift 2 ;;
    --key) KEY=$2; shift 2 ;;
    --tls-from) TLS_FROM=$2; shift 2 ;;
    --no-tls) NO_TLS=1; shift ;;
    --file) FILE=$2; shift 2 ;;
    --ref) REF=$2; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

[ "$DRY" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root: sudo bash $0 $*"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port must be a number"

# Write a file, or show it in a dry run.
put() {
  local path=$1 content=$2
  if [ "$DRY" = 1 ]; then printf -- '--- %s\n%s\n' "$path" "$content"; else printf '%s\n' "$content" > "$path"; fi
}
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }

if [ "$UNINSTALL" = 1 ]; then
  run systemctl disable --now "$NAME.service" "$NAME-cert.timer" 2>/dev/null || true
  run rm -f "$UNIT_DIR/$NAME.service" "$UNIT_DIR/$NAME-cert.service" "$UNIT_DIR/$NAME-cert.timer"
  run rm -rf "$DIR"
  run systemctl daemon-reload
  say "Removed. Close port $PORT in the cloud firewall if you opened it."
  exit 0
fi

# ---- Node ----
NODE=$(command -v node || true)
[ -n "$NODE" ] || die "Node.js is not installed (needs 20 or newer)"
NODE_MAJOR=$("$NODE" -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $("$NODE" -v) is too old: needs 20 or newer"
say "Node $("$NODE" -v) at $NODE"

# ---- Keep port/secret from an earlier install ----
OLD_UNIT="$UNIT_DIR/$NAME.service"
if [ -f "$OLD_UNIT" ]; then
  [ -n "$SECRET" ] || SECRET=$(sed -n 's/^Environment=PATH_PREFIX=//p' "$OLD_UNIT" | head -1)
  say "Updating the existing install (keeping its secret)"
fi
[ -n "$SECRET" ] || SECRET=$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
[[ "$SECRET" =~ ^[A-Za-z0-9_-]{8,}$ ]] || die "the secret must be 8+ letters, digits, - or _"

# ---- Certificate ----
# The real file behind a credential of another service: TLS_CERT in its
# environment may point into /run/credentials/<service>/<name>, which only that
# service can see; LoadCredential=<name>:<file> in its unit names the source.
source_of() {
  local svc=$1 var=$2 val name src
  val=$(systemctl show "$svc" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n "s/^$var=//p" | head -1)
  if [ -z "$val" ]; then
    local pid
    pid=$(systemctl show "$svc" -p MainPID --value 2>/dev/null || echo 0)
    [ "${pid:-0}" != 0 ] && val=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -n "s/^$var=//p" | head -1)
  fi
  [ -n "$val" ] || return 1
  case "$val" in
    /run/credentials/*|%d/*|'${CREDENTIALS_DIRECTORY}'/*|'$CREDENTIALS_DIRECTORY'/*)
      name=${val##*/}
      src=$(systemctl cat "$svc" 2>/dev/null | sed -n "s/^LoadCredential=$name://p" | head -1)
      [ -n "$src" ] || return 1
      echo "$src" ;;
    *) echo "$val" ;;
  esac
}

if [ "$NO_TLS" = 0 ] && [ -z "$CERT$KEY" ]; then
  if [ -z "$TLS_FROM" ] && systemctl cat bili-relay >/dev/null 2>&1; then TLS_FROM=bili-relay; fi
  if [ -n "$TLS_FROM" ]; then
    CERT=$(source_of "$TLS_FROM" TLS_CERT) || die "couldn't find $TLS_FROM's certificate; pass --cert and --key"
    KEY=$(source_of "$TLS_FROM" TLS_KEY) || die "couldn't find $TLS_FROM's key; pass --cert and --key"
    say "Using $TLS_FROM's certificate: $CERT"
  elif [ -f "$OLD_UNIT" ]; then
    CERT=$(sed -n 's/^LoadCredential=tls.crt://p' "$OLD_UNIT" | head -1)
    KEY=$(sed -n 's/^LoadCredential=tls.key://p' "$OLD_UNIT" | head -1)
  fi
  [ -n "$CERT" ] && [ -n "$KEY" ] || die "no certificate found: pass --cert F --key F (or --no-tls for plain HTTP)"
fi
if [ "$NO_TLS" = 0 ]; then
  [ -r "$CERT" ] || die "can't read certificate $CERT"
  [ -r "$KEY" ] || die "can't read key $KEY"
fi

# ---- server.mjs ----
run mkdir -p "$DIR"
if [ -n "$FILE" ]; then
  [ -r "$FILE" ] || die "can't read $FILE"
  run install -m 0644 "$FILE" "$DIR/server.mjs"
  say "Installed $FILE"
elif [ "$DRY" = 1 ]; then
  echo "+ download relay/server.mjs ($REF) to $DIR/server.mjs"
else
  RAW="https://raw.githubusercontent.com/$REPO/$REF/relay/server.mjs"
  TMP=$(mktemp)
  ok=0
  for url in "$RAW" "https://gh-proxy.com/$RAW" "https://ghfast.top/$RAW" "https://cdn.jsdelivr.net/gh/$REPO@$REF/relay/server.mjs"; do
    if curl -fsSL --max-time 60 -o "$TMP" "$url" && grep -q "tvbox-relay" "$TMP"; then ok=1; say "Downloaded server.mjs from ${url%%/relay/*}…"; break; fi
  done
  [ "$ok" = 1 ] || { rm -f "$TMP"; die "couldn't download server.mjs; copy it over and use --file"; }
  install -m 0644 "$TMP" "$DIR/server.mjs"
  rm -f "$TMP"
fi
[ "$DRY" = 1 ] || "$NODE" --check "$DIR/server.mjs" || die "server.mjs doesn't parse"

# ---- systemd units ----
# Run as a throwaway user, unless Node lives in a home directory (nvm), which
# that user can't reach: then run as the owner of that Node.
NODE_REAL=$(readlink -f "$NODE")
case "$NODE_REAL" in
  /home/*|/root/*)
    NODE_USER=$(stat -c %U "$NODE_REAL")
    SANDBOX="User=$NODE_USER
NoNewPrivileges=yes
ProtectSystem=strict
PrivateTmp=yes"
    say "Node is under a home directory: the relay runs as $NODE_USER" ;;
  *)
    SANDBOX="DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes" ;;
esac

TLS_LINES=
if [ "$NO_TLS" = 0 ]; then
  TLS_LINES="LoadCredential=tls.crt:$CERT
LoadCredential=tls.key:$KEY
Environment=TLS_CERT=%d/tls.crt
Environment=TLS_KEY=%d/tls.key"
fi
put "$UNIT_DIR/$NAME.service" "# Written by samsung-tvbox relay/setup.sh; re-run it instead of editing.
[Unit]
Description=samsung-tvbox HLS relay
After=network-online.target
Wants=network-online.target

[Service]
Environment=PORT=$PORT
Environment=PATH_PREFIX=$SECRET
$TLS_LINES
ExecStart=$NODE_REAL $DIR/server.mjs
Restart=always
RestartSec=3
$SANDBOX

[Install]
WantedBy=multi-user.target"

if [ "$NO_TLS" = 0 ]; then
  # systemd copies credentials when the service starts: restart it when the
  # certificate file has changed since (Let's Encrypt renewals).
  put "$UNIT_DIR/$NAME-cert.service" "# Written by samsung-tvbox relay/setup.sh.
[Unit]
Description=Restart the samsung-tvbox relay after a certificate renewal

[Service]
Type=oneshot
ExecStart=/bin/sh -c 'cmp -s \"\$(readlink -f $CERT)\" /run/credentials/$NAME.service/tls.crt || systemctl try-restart $NAME.service'"
  put "$UNIT_DIR/$NAME-cert.timer" "# Written by samsung-tvbox relay/setup.sh.
[Unit]
Description=Check the samsung-tvbox relay's certificate hourly

[Timer]
OnBootSec=10min
OnUnitActiveSec=1h

[Install]
WantedBy=timers.target"
fi

run systemctl daemon-reload
run systemctl enable "$NAME.service"
run systemctl restart "$NAME.service"
[ "$NO_TLS" = 1 ] || run systemctl enable --now "$NAME-cert.timer"

# ---- Firewall on the server ----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  run ufw allow "$PORT/tcp" >/dev/null && say "ufw: allowed $PORT/tcp"
fi

[ "$DRY" = 1 ] && exit 0

# ---- Check ----
SCHEME=https; [ "$NO_TLS" = 1 ] && SCHEME=http
sleep 2
if curl -fsSk --max-time 10 "$SCHEME://127.0.0.1:$PORT/$SECRET/health" >/dev/null; then
  say "Relay is running."
else
  echo "The relay doesn't answer yet. Log:" >&2
  journalctl -u "$NAME" -n 20 --no-pager >&2 || true
  exit 1
fi
IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 5 https://ip.3322.net 2>/dev/null || hostname -I | awk '{print $1}')
IP=$(echo "$IP" | tr -d '[:space:]')
cat <<EOF

Done. On the TV, 设置 → 中转服务器:

    $SCHEME://$IP:$PORT/$SECRET

Keep this address private. Still to do, once:
  - Open TCP $PORT in the cloud firewall (Tencent Cloud: 轻量应用服务器 → 防火墙 → 添加规则).
  - From home, check: curl $SCHEME://$IP:$PORT/$SECRET/health

Traffic per hour: journalctl -u $NAME -g traffic
Update later:     re-run this script (it keeps the secret)
EOF

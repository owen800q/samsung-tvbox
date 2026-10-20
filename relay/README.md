# HLS relay (optional)

Many lines in the public IPTV lists only answer viewers in mainland China: provincial cable and ISP IPTV, such as 广东有线 or 中国移动. A TV elsewhere (Hong Kong, overseas) can play them through this relay on a server in mainland China. The TV tries every line directly first; the relay only adds more lines.

`server.mjs` is one file with no dependencies (Node 20+). It fetches the stream on the server and rewrites each playlist so segments, variants and keys come through it too. It also passes on `Range`.

## What it costs

Live TV is a constant 3–8 Mbps. That's about **1.5–3.5 GB per hour** of viewing, all through the server, both in and out. Check your plan's bandwidth and monthly traffic: small cloud plans in China often cap at a few Mbps or a few hundred GB per month. The relay logs its traffic every hour (`journalctl -u tvbox-relay -g traffic`).

The relay only helps lines that are refused outside mainland China. Lines on overseas servers (US IP:port hosts) get slower through it, so the TV tries those directly first. Lines that only work inside one ISP's own network fail through it too.

## Install on the server: the script

`setup.sh` does the steps below in one go:
- checks Node;
- downloads `server.mjs` (falling back to GitHub mirrors);
- creates a secret, or keeps the one from an earlier install;
- reuses the certificate of the `bili-relay` service when there is one, found through its `LoadCredential=` lines;
- writes and starts a systemd service that runs as a throwaway user;
- adds an hourly timer that restarts the relay after a certificate renewal;
- opens the port in `ufw` if it's active;
- prints the address to enter on the TV.

```sh
curl -fsSL https://raw.githubusercontent.com/owen800q/samsung-tvbox/main/relay/setup.sh -o setup.sh
sudo bash setup.sh                      # or: --cert F --key F, --port N, --no-tls, --dry-run, --uninstall
```

If GitHub is slow from the server, put `https://gh-proxy.com/` in front of the URL. Re-run the script to update the relay; it keeps the port and secret. You still need to open the port (default **9997**, TCP) in the cloud firewall yourself: for Tencent Cloud Lighthouse, go to 轻量应用服务器 → the server → 防火墙 → 添加规则.

## Install on the server: by hand

The address and secret below are examples: use your own. Keep the relay address private. Don't put it in this repository, which is public, or in its builds: enter it on the TV only.

```sh
# 1. Node 20 or newer
node -v

# 2. The relay file (no install step). If GitHub is slow from the server,
#    copy relay/server.mjs over with scp instead.
sudo mkdir -p /opt/tvbox-relay
sudo curl -fsSL -o /opt/tvbox-relay/server.mjs \
  https://raw.githubusercontent.com/owen800q/samsung-tvbox/main/relay/server.mjs

# 3. A secret for the URL path
openssl rand -hex 16
```

**4. HTTPS.** Use HTTPS across China's border: the TV's plain-HTTP requests to a server in China get their replies dropped. If the server already has a certificate (for example the one another relay uses), point `TLS_CERT`/`TLS_KEY` at the same files. The relay re-reads them every 12 hours, so renewals are picked up.

**5. A systemd service.** Create `/etc/systemd/system/tvbox-relay.service`:

```ini
[Unit]
Description=samsung-tvbox HLS relay
After=network-online.target
Wants=network-online.target

[Service]
Environment=PORT=9997
Environment=PATH_PREFIX=<secret from step 3>
Environment=TLS_CERT=/path/to/fullchain.pem
Environment=TLS_KEY=/path/to/privkey.pem
ExecStart=/usr/bin/node /opt/tvbox-relay/server.mjs
Restart=always
RestartSec=3
# The user must be able to read the certificate files.
User=root

[Install]
WantedBy=multi-user.target
```

Use the path `which node` prints in `ExecStart`. Then start it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now tvbox-relay
sudo systemctl status tvbox-relay --no-pager      # "tvbox relay on https :9997 (prefix set)"
```

**6. Open the port.** Allow TCP 9997 in the cloud firewall: for Tencent Cloud Lighthouse, go to 控制台 → 轻量应用服务器 → the server → 防火墙 → 添加规则. If `ufw` is active on the server, also run `sudo ufw allow 9997/tcp`.

**7. Check it from home:**

```sh
curl https://<server>:9997/<secret>/health
# {"ok":true,"service":"tvbox-relay",...}

# Which lines the relay rescues, from the TV's network (in this repo):
npm run check:streams -- --relay https://<server>:9997/<secret>
```

## On the TV

Go to 设置 → 中转服务器, enter `https://<server>:9997/<secret>` and press OK. Each channel then gets relayed copies of its lines after the direct ones; the banner shows `线路 9/14（中转）` when one plays. Turn on 优先使用中转 to try the relayed lines first. To turn the relay off, clear the address.

## Update or remove

- **Update:** fetch `server.mjs` again (step 2), then `sudo systemctl restart tvbox-relay`.
- **Remove:** `sudo systemctl disable --now tvbox-relay && sudo rm /etc/systemd/system/tvbox-relay.service`, and close the port.

## Safety

- **Secret path:** requests outside the secret path get 404, so only someone who knows the address can use the relay.
- **Blocked addresses:** the relay refuses private, loopback and link-local addresses, which includes the cloud's metadata service, both for the target and after DNS. So it can't be used to reach the server's own network.
- **Request types:** only GET and HEAD, and only http(s) targets.

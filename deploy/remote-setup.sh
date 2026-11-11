#!/bin/bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v24\.'; then
  curl -fsSL https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-arm64.tar.xz -o /tmp/node.tar.xz
  tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
  rm -f /tmp/node.tar.xz
fi

if ! command -v caddy >/dev/null 2>&1; then
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=arm64" -o /usr/local/bin/caddy
  chmod 755 /usr/local/bin/caddy
fi

id pencils >/dev/null 2>&1 || useradd --system --home /opt/pencils --shell /sbin/nologin pencils
mkdir -p /opt/pencils /var/lib/pencils /etc/caddy
chown -R pencils:pencils /opt/pencils /var/lib/pencils

cp /opt/pencils/deploy/pencils.service /etc/systemd/system/pencils.service
cp /opt/pencils/deploy/caddy.service /etc/systemd/system/caddy.service
cp /opt/pencils/deploy/Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable pencils caddy
systemctl restart pencils
systemctl restart caddy
systemctl is-active pencils
systemctl is-active caddy

#!/usr/bin/env bash
set -euo pipefail
umask 022

# Native Linux deployment for hosts with Node.js 24+ and systemd.
[[ "$(id -u)" == 0 ]] || { echo "Run this script as root." >&2; exit 1; }
repo_slug="${1:-detydanesu/orbit-ops}"
[[ "$repo_slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
for tool in node npm git openssl systemctl curl awk nice; do
  command -v "$tool" >/dev/null || { echo "Install $tool first." >&2; exit 1; }
done
node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'

# Native modules can exhaust a small host and disrupt unrelated services.
if [[ -r /proc/meminfo ]]; then
  available_kib="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
  swap_free_kib="$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)"
  if [[ -n "$available_kib" && -n "$swap_free_kib" ]] &&
     (( available_kib + swap_free_kib < 1572864 )); then
    echo "Native installation needs at least 1.5 GiB of available RAM and swap. Add swap or use a larger host before deploying." >&2
    exit 1
  fi
fi

# Keep native compilation from monopolizing a small VPS during updates.
export MAKEFLAGS="${MAKEFLAGS:--j1}"
app_dir=/opt/orbit-ops
if [[ -d "$app_dir/.git" ]]; then
  [[ -z "$(git -C "$app_dir" status --porcelain)" ]] || { echo "Checkout has local changes; preserve them before updating." >&2; exit 1; }
  git -C "$app_dir" pull --ff-only
elif [[ ! -e "$app_dir" ]]; then
  git clone --depth 1 "https://github.com/${repo_slug}.git" "$app_dir"
else
  echo "$app_dir already exists. Inspect it before deployment." >&2; exit 1
fi
id orbit-ops >/dev/null 2>&1 || useradd --system --home-dir /var/lib/orbit-ops --shell /usr/sbin/nologin orbit-ops
install -d -m 700 /etc/orbit-ops
install -d -m 700 -o orbit-ops -g orbit-ops /var/lib/orbit-ops
if [[ ! -e /etc/orbit-ops/environment ]]; then
  (
  umask 077
  cat > /etc/orbit-ops/environment <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=8787
DATA_DIR=/var/lib/orbit-ops
COOKIE_SECURE=true
ADMIN_PASSWORD=$(openssl rand -hex 24)
SESSION_SECRET=$(openssl rand -hex 32)
DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
EOF
  )
fi
cd "$app_dir"
nice -n 10 npm ci
nice -n 10 npm run build
nice -n 10 npm prune --omit=dev
# Make build outputs readable by the dedicated service user, including on repair.
chmod -R a+rX "$app_dir/dist" "$app_dir/node_modules"
node_binary="$(command -v node)"
cat > /etc/systemd/system/orbit-ops.service <<EOF
[Unit]
Description=Orbit Ops infrastructure workspace
After=network.target

[Service]
Type=simple
User=orbit-ops
Group=orbit-ops
WorkingDirectory=/opt/orbit-ops
EnvironmentFile=/etc/orbit-ops/environment
ExecStart=${node_binary} /opt/orbit-ops/server/index.cjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/orbit-ops

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable orbit-ops.service
systemctl restart orbit-ops.service
for attempt in {1..20}; do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    echo "Orbit Ops is healthy on http://127.0.0.1:8787"
    echo "Credentials: /etc/orbit-ops/environment (root only)."
    exit 0
  fi
  sleep 1
done
echo "Orbit failed its startup check. Inspect journalctl -u orbit-ops." >&2
exit 1

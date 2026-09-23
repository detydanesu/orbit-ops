#!/usr/bin/env bash
set -euo pipefail

repo_slug="${1:-}"
install_dir="${ORBIT_INSTALL_DIR:-/opt/orbit-ops}"

if [[ -n "$repo_slug" ]]; then
  if [[ ! "$repo_slug" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "Expected a GitHub repository as OWNER/REPOSITORY." >&2
    exit 2
  fi
  command -v git >/dev/null || { echo "Install git, then rerun this command." >&2; exit 1; }
  if [[ -d "$install_dir/.git" ]]; then
    git -C "$install_dir" pull --ff-only
  elif [[ ! -e "$install_dir" ]]; then
    git clone --depth 1 "https://github.com/${repo_slug}.git" "$install_dir"
  else
    echo "$install_dir already exists and is not a Git checkout. Set ORBIT_INSTALL_DIR to another path." >&2
    exit 1
  fi
  app_dir="$install_dir"
else
  app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

command -v docker >/dev/null || { echo "Install Docker Engine with the Compose plugin, then rerun this command." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose is required. Install the Docker Compose plugin, then rerun this command." >&2; exit 1; }
command -v openssl >/dev/null || { echo "Install openssl, then rerun this command." >&2; exit 1; }

cd "$app_dir"
if [[ ! -f .env ]]; then
  umask 077
  admin_password="$(openssl rand -hex 24)"
  session_secret="$(openssl rand -hex 32)"
  encryption_key="$(openssl rand -hex 32)"
  cat > .env <<EOF
NODE_ENV=production
PORT=8787
APP_PORT=8787
COOKIE_SECURE=true
ADMIN_PASSWORD=${admin_password}
SESSION_SECRET=${session_secret}
DATA_ENCRYPTION_KEY=${encryption_key}
EOF
  chmod 600 .env
  echo "Generated the first dashboard password. Save it now; it will not be shown again:"
  echo "$admin_password"
fi

docker compose up -d --build
app_port="$(awk -F= '$1 == "APP_PORT" {print $2}' .env)"
app_port="${app_port:-8787}"
echo "Orbit Ops is listening on http://127.0.0.1:${app_port}"
echo "For a Cloudflare Tunnel on this host, route its service to http://localhost:${app_port}."

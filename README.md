# Orbit Ops

A self-hosted topology dashboard for VPS hosts, services, and tunnels. It is a single-admin app that runs beside the VPS inventory it manages.

## What it does

- Map VPSes, Cloudflare Tunnels, external endpoints, and services on one draggable graph.
- Add a VPS with SSH key authentication and check that the SSH connection succeeds.
- Pin the SSH host fingerprint on first use; a changed key must be checked against the provider console before it can be trusted.
- Store graph data in SQLite and encrypt SSH private keys and key passphrases with AES-256-GCM.
- Keep Cloudflare and other service entries as topology inventory. They are not continuously monitored and do not call provider APIs.

The dashboard host must be able to make outbound SSH connections to each VPS. The browser never opens an SSH socket and never receives a saved private key back from the server.

## Run locally

Requires Node.js 24 or newer.

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. The local development password is `local-dev-change-me`. The dev-only encryption key is fixed for convenience; never expose a development server to the Internet or use it for real SSH keys.

## Deploy on a VPS

Install Docker Engine with the Compose plugin, Git, curl, and OpenSSL first. Push this source to a public GitHub repository, then run this command on the target VPS as root (replace `OWNER/REPOSITORY`):

```sh
curl -fsSL https://raw.githubusercontent.com/OWNER/REPOSITORY/main/deploy.sh | sudo bash -s -- OWNER/REPOSITORY
```

The script clones the repository into `/opt/orbit-ops`, generates the dashboard password and encryption keys once, and starts the app with Docker Compose. It prints the password once; save it securely. The web port is bound to `127.0.0.1:8787`, so it is not exposed directly to the public Internet.

For a Cloudflare Tunnel running on the same VPS, set its public hostname service to `http://localhost:8787`. The tunnel handles public HTTPS while the app remains local to the VPS. If the tunnel runs in a separate Docker network, connect it to that network and use the dashboard container as its origin.

To update an existing install after pushing to `main`, rerun the same command. To inspect it:

```sh
cd /opt/orbit-ops && docker compose ps
cd /opt/orbit-ops && docker compose logs -f dashboard
```

The SQLite database lives in the `orbit-data` Docker volume. Back up that volume and the private `.env` file together: losing `DATA_ENCRYPTION_KEY` makes saved SSH keys unrecoverable. Never commit `.env` or copy it into a public repository.

## Configuration

`deploy.sh` creates `.env` on first deployment. For manual setup, copy `.env.example` to `.env` and set unique random values for `ADMIN_PASSWORD`, `SESSION_SECRET`, and `DATA_ENCRYPTION_KEY` (64 hexadecimal characters for the encryption key). Keep `COOKIE_SECURE=true` when access is through HTTPS.

```sh
docker compose up -d --build
```

## Data and security boundaries

- One local administrator password controls the dashboard; there are no user accounts or remote identity integrations.
- SSH keys are encrypted at rest using the `DATA_ENCRYPTION_KEY`. SSH host fingerprints are pinned before authentication; verify the first fingerprint through your VPS provider's console.
- Deleting a host removes its encrypted key and graph links from the database.
- Service and tunnel nodes are user-maintained inventory, not live status checks.
- The published host port binds to loopback. Expose it through an HTTPS reverse proxy or Cloudflare Tunnel, not a public plain-HTTP port.

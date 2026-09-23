# Orbit Ops

A self-hosted topology dashboard for VPS hosts, services, and tunnels. It is a single-admin app that runs beside the VPS inventory it manages.

## What it does

- Map VPSes and services on draggable, named graph boards. Record a tunnel or external endpoint as a service with its provider and endpoint.
- Switch between Map and Desktop views using the header toggle; both share the same saved resources. Your view preference is remembered in this browser.
- Open desktop resource windows, move or resize them, and minimize/restore them from the dock. On small screens, windows fit the viewport and forms scroll.
- Upload SSH config and private-key files only in **SSH Files**, then select saved aliases and keys when adding a VPS. Private keys are encrypted on the server; verify the SSH host fingerprint before opening a terminal.
- Edit saved VPS and service details from their resource windows. Changing a VPS host or port clears its host-key trust for re-verification.
- Pin the SSH host fingerprint on first use; a changed key must be checked against the provider console before it can be trusted.
- Store graph data in SQLite and encrypt SSH private keys and key passphrases with AES-256-GCM.
- Keep Cloudflare and other service entries as topology inventory. They are not continuously monitored and do not call provider APIs.

The dashboard host must be able to make outbound SSH connections to each VPS. The browser never opens an SSH socket and never receives a saved private key back from the server. The terminal relays an interactive SSH shell through an authenticated, same-origin WebSocket; it is enabled only after you verify and pin the host fingerprint.

## Workspace views and graph boards

Use **Add graph** to create a separate board for a location or project, and use its tab to switch boards. New resources belong to the selected board; links stay within that board. The pencil button renames the board or removes an empty board. The original board cannot be deleted.

Existing installations are migrated automatically: all previous resources, encrypted keys, positions, and links remain in **Network graph**. Back up the database and encryption key before upgrading.

Use the **Map / Desktop** toggle at any time. Desktop shortcuts open resource controls, including the browser SSH terminal for verified hosts. The dock restores minimized windows and brings open windows to the front.

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
curl -fsSL https://raw.githubusercontent.com/detydanesu/orbit-ops/main/deploy.sh | sudo bash -s -- detydanesu/orbit-ops
```

The script clones the repository into `/opt/orbit-ops`, generates the dashboard password and encryption keys once, and starts the app with Docker Compose. It prints the password once; save it securely. The web port is bound to `127.0.0.1:8787`, so it is not exposed directly to the public Internet.

For a Cloudflare Tunnel running on the same VPS, set its public hostname service to `http://localhost:8787`. The tunnel handles public HTTPS while the app remains local to the VPS. If the tunnel runs in a separate Docker network, connect it to that network and use the dashboard container as its origin.

To update an existing install after pushing to `main`, rerun the same command. To inspect it:

```sh
cd /opt/orbit-ops && docker compose ps
cd /opt/orbit-ops && docker compose logs -f dashboard
```

The SQLite database lives in the `orbit-data` Docker volume. Back up that volume and the private `.env` file together: losing `DATA_ENCRYPTION_KEY` makes saved SSH keys unrecoverable. Never commit `.env` or copy it into a public repository.

### Native Linux service (without Docker)

On a systemd host with Node.js 24+, npm, Git, OpenSSL, curl, and the native build tools installed:

```sh
curl -fsSL https://raw.githubusercontent.com/detydanesu/orbit-ops/main/deploy-systemd.sh | sudo bash -s -- detydanesu/orbit-ops
```

This installs the `orbit-ops` system service with a dedicated user, listening on `127.0.0.1:8787`. It preserves generated credentials across updates in `/etc/orbit-ops/environment` (root only). Read `ADMIN_PASSWORD` there to sign in. The database lives in `/var/lib/orbit-ops`; back it up together with the environment file. Use an HTTPS reverse proxy or Cloudflare Tunnel for browser access. Rerun the same command to update.

## Import an SSH config

Open **SSH Files** from the header, choose your `.ssh/config` file, review the parsed host aliases, give the file a library name, and save it. The config is parsed in your browser; its original text is not sent to or stored on the server.

In **Add connection > VPS / SSH**, choose a saved host alias to fill in the host, user, and port. Config uploads and deletion are available only in SSH Files. The importer applies matching Host patterns and first-value precedence, including wildcard defaults. It does not execute commands or follow Include paths. Entries requiring ProxyCommand, ProxyJump, Include, or Match are saved with a warning and disabled for selection until configured manually. URL-shaped HostName values are also retained as flagged entries. Other SSH options are not imported.

SSH Files lists saved config names, host aliases, reusable keys, and keys attached to a VPS. Add and save a context note for each config or key. A VPS-attached key can be removed from its host in the library; Orbit then disables SSH access for that host until a key is added again.

## OpenSSH key-pair login

1. Install your public key in `~/.ssh/authorized_keys` for the VPS account.
2. Open **SSH Files**, upload the OpenSSH private-key file (`id_ed25519`, `id_rsa`, or PEM), and enter its passphrase if it is encrypted. A `.pub` file alone cannot authenticate.
3. Give the key a library name and save it. The private key and passphrase are encrypted at rest and never returned by the API.
4. In **Add connection > VPS / SSH**, select a saved host alias if desired, then choose the private key from SSH Files. Direct upload or paste is not available in this form.
5. Check SSH, verify the separate server host-key fingerprint against a trusted source, then open the terminal.

This uses direct SSH from the Orbit server. Cloudflare Access SSH hostnames require a separately configured transport.

## Editing saved resources

Open a resource's details and choose **Edit** to update its name, VPS target and location, or service provider and endpoint. Map links are preserved. Changing a VPS host or port clears its saved host-key trust, so verify the new fingerprint before opening a terminal.

## Configuration

`deploy.sh` creates `.env` on first deployment. For manual setup, copy `.env.example` to `.env` and set unique random values for `ADMIN_PASSWORD`, `SESSION_SECRET`, and `DATA_ENCRYPTION_KEY` (64 hexadecimal characters for the encryption key). Keep `COOKIE_SECURE=true` when access is through HTTPS.

```sh
docker compose up -d --build
```

## Data and security boundaries

- One local administrator password controls the dashboard; there are no user accounts or remote identity integrations.
- SSH keys are encrypted at rest using the `DATA_ENCRYPTION_KEY`. SSH host fingerprints are pinned before authentication; verify the first fingerprint through your VPS provider's console.
- Interactive terminals use the saved key on the server and open a PTY only; the private key is not exposed to the browser. Keep dashboard access protected and close the terminal window to end its SSH session.
- Deleting a host removes its encrypted key and graph links from the database.
- Service and tunnel nodes are user-maintained inventory, not live status checks.
- The published host port binds to loopback. Expose it through an HTTPS reverse proxy or Cloudflare Tunnel, not a public plain-HTTP port.

## Development checks

```sh
npm run build
npm run lint
node --test tests/*.test.cjs
```

Board tests run against isolated temporary databases and cover migration, authentication, board separation, cross-board link rejection, and safe deletion.

# wavelet-server

The server behind [Wavelet](https://github.com/Paarth-K/wavelet-desk), a wall-mounted Spotify "now playing" display made
of two ESP32 boards. It is the only thing that talks to Spotify: it polls the player and the queue, keeps one versioned
state for the boards to long-poll, downloads every cover once and turns it into ready-to-draw RGB565 textures, so neither
board decodes a JPEG.

The contract with the firmware is the "Server HTTP API" section of
[docs/protocol.md](https://github.com/Paarth-K/wavelet-desk/blob/main/docs/protocol.md) in the firmware repository.

Node 20+, TypeScript, `node:http` and the global `fetch`. One runtime dependency: [`jpeg-js`](https://github.com/jpeg-js/jpeg-js)
(pure JavaScript). The resampling and the dither are done here.

## Configuration

Environment variables only; nothing secret lives in the repository.

| variable | | |
|---|---|---|
| `WAVELET_API_KEY` | required | the one key for everything, at least 64 printable characters (`openssl rand -base64 48`). The server refuses to start without it. |
| `SPOTIFY_CLIENT_ID` | required | your Spotify app's client id |
| `SPOTIFY_CLIENT_SECRET` | optional | with it, the token exchange and refresh use HTTP Basic client authentication; without it, PKCE alone. The authorize link uses PKCE (S256) either way. |
| `SPOTIFY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | where Spotify sends the browser after approval; see [Link Spotify](#link-spotify) |
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `DATA_DIR` | `./data` | holds `token.json` (the refresh token), `geo.json` (the geometry and the S3 brightness) and `covers/` (original JPEGs, the newest 500). Use persistent storage. |

`.env.example` lists them. The server does not read `.env` itself: put the values in the environment.

## Run locally

```
pnpm install
pnpm build
set -a; . ./.env; set +a     # or export the variables some other way
pnpm start                   # node dist/server.js
```

`pnpm dev` runs `src/server.ts` with tsx and restarts on changes. `pnpm test` type-checks and runs the tests
(`node:test`; Spotify and the cover CDN are faked, nothing leaves the machine; Node 20.6+ for `--import`).

## Link Spotify

Open the admin page, `https://<host>/`. The browser asks for a user name and password: any user name, and the API key as the
password. Then:

- **Redirect to this server** (`SPOTIFY_REDIRECT_URI=https://<host>/callback`): click **Link Spotify**, approve, and
  Spotify sends you back to `/callback`, which checks the state, exchanges the code and returns you to the admin page.
- **Default loopback redirect** (`http://127.0.0.1:8888/callback`): click **Link Spotify** (a new tab) and approve. Spotify
  redirects to `127.0.0.1:8888`, which nothing serves, so that tab shows an error. Copy the whole address from its address
  bar, paste it into the box on the admin page, and click **Finish linking**.

Either way, the redirect URI must be added under **Redirect URIs** in your app's settings on the
[Spotify developer dashboard](https://developer.spotify.com/dashboard), exactly as configured here.

The refresh token is saved in `DATA_DIR/token.json` (mode 600); access tokens stay in memory. Neither, nor the API key or the
client secret, is ever logged. If Spotify revokes the refresh token, the page shows "not linked" again. The page also has
**Unlink**, the S3 brightness (16 buttons: match the S3 to the main screen by eye) and the geometry form (saving either bumps the state version, so the boards pick it up within a second or two).

## API

Every route except `/healthz` needs the API key. Without it the answer is a bare `401`.

| route | auth | |
|---|---|---|
| `GET /api/state?v=<n>&wait=<s>` | header `X-Wavelet-Key` | the state JSON; waits up to `wait` seconds (max 25) while `v` is the current version |
| `GET /api/img/<key>/<variant>` | header `X-Wavelet-Key` | `home` 152x136, `flight` 112x112, `sq160`, `sq36`: raw little-endian RGB565. `404` for an unknown key, `503` + `Retry-After` if it is still being made after 10 s |
| `GET /`, `GET /callback`, `POST /link`, `/unlink`, `/geo`, `/bright` | HTTP Basic, password = the key | the admin page and Spotify's redirect |
| `GET /healthz` | none | `ok` |

Details (the JSON fields, when the version moves, the texel geometry and the dither) are in
[docs/protocol.md](https://github.com/Paarth-K/wavelet-desk/blob/main/docs/protocol.md).

Spotify's development-mode quota is shared by every app on the developer account, so polling is frugal: every 3 s while
playing plus one poll at each track's predicted end (and 1 s and 2 s after it if Spotify still shows the old track);
every 5 s while paused or idle for 10 minutes after playback, then every 15 s; the queue on each track change and every
30 s while playing. A 429 honours `Retry-After`; `QUOTA_EXCEEDED` backs off 60 s, doubling up to 30 minutes. Network
errors back off 5, 10, 20, 30 s.

## Deploy with Railpack (Coolify, Dokploy, Railway, ...)

The repository builds as is with [Railpack](https://railpack.com)'s Node provider: it finds `pnpm-lock.yaml` and the
`packageManager` field, installs with `pnpm install --frozen-lockfile`, runs `pnpm build` (tsc, into `dist/`) and starts with
`pnpm start` (`node dist/server.js`). Node comes from `engines` (`>=20`).

1. Create an app from this repository with the Railpack builder.
2. Set the environment: `WAVELET_API_KEY`, `SPOTIFY_CLIENT_ID`, and optionally `SPOTIFY_CLIENT_SECRET`,
   `SPOTIFY_REDIRECT_URI` (e.g. `https://wavelet.example.com/callback`), `PORT` (default 3000, the port to expose).
3. Mount a persistent volume at `/data` and set `DATA_DIR=/data`, so the refresh token, the geometry and the covers
   survive redeploys.
4. Point the domain at port 3000 with TLS terminated by the host's proxy. The health check is `GET /healthz`.

Long-polls last up to 25 s, so the proxy's read timeout must be longer than that (the usual defaults, 60 s or more, are
fine). The server never looks at `X-Forwarded-*` headers for authentication, so nothing a proxy adds can let a request
through.

## Deploy on a plain Linux machine (systemd)

```
sudo useradd --system --home /var/lib/wavelet --create-home wavelet
sudo git clone https://github.com/Paarth-K/wavelet-server.git /opt/wavelet-server
cd /opt/wavelet-server && sudo pnpm install --frozen-lockfile && sudo pnpm build
sudo install -m 600 -o root -g root /dev/null /etc/wavelet-server.env
sudoedit /etc/wavelet-server.env      # the variables above; HOST=127.0.0.1 behind a local proxy, DATA_DIR=/var/lib/wavelet
```

`/etc/systemd/system/wavelet-server.service`:

```
[Unit]
Description=Wavelet server
After=network-online.target
Wants=network-online.target

[Service]
User=wavelet
EnvironmentFile=/etc/wavelet-server.env
WorkingDirectory=/opt/wavelet-server
ExecStart=/usr/bin/node /opt/wavelet-server/dist/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/wavelet
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now wavelet-server
journalctl -u wavelet-server -f
```

Put TLS in front with a reverse proxy, e.g. Caddy:

```
wavelet.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

To update: `git pull && pnpm install --frozen-lockfile && pnpm build && sudo systemctl restart wavelet-server`.

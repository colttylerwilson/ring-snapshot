# Ring Snapshot Proxy

Self-hosted adapter that turns a Ring camera into pollable JPEG URLs.

---

## Endpoints

- GET /ring/snapshot.jpg
  - Fast, low-res snapshot (~640×360)

- GET /ring/frame.jpg
  - High-res still (confirmed up to 1920×1080)
  - Starts a live stream and extracts 1 frame via ffmpeg
  - Slower/heavier than /ring/snapshot.jpg
  - Cached to avoid repeated stream startups

If BASIC_AUTH_USER and BASIC_AUTH_PASS are set, both /ring/* endpoints require Basic Auth.

---

## What you need

- Docker Desktop (Mac/Windows) or Docker Engine (Linux)
- A Ring account with at least one camera

Notes:
- ffmpeg is included inside the Docker image (no host install required).
- Setup requires an interactive Ring login + 2FA once.

---

## Quick start (recommended: Docker-only)

### 1) Clone the repo
```bash
    git clone https://github.com/colttylerwilson/ring-snapshot.git
    cd ring-snapshot
```

### 2) Create your .env
```bash
    cp .env.example .env
```

Optional but recommended if you’ll expose this publicly (change these lines inside .env):

    BASIC_AUTH_USER=Shalalala
    BASIC_AUTH_PASS=change-me

Important:
- Do NOT try to fill RING_REFRESH_TOKEN or RING_CAMERA_ID by hand.
- The guided setup step below will write them into .env automatically.

### 3) Build the Docker image
```bash
    docker build -t ring-snapshot-proxy .
```

### 4) Run guided setup (writes RING_REFRESH_TOKEN + RING_CAMERA_ID into .env)

This step:
- Prompts you for Ring login + 2FA
- Lists all cameras on the account
- Asks you to choose which camera to use
- Writes both RING_REFRESH_TOKEN and RING_CAMERA_ID into your host .env
```bash
    docker run --rm -it \
      --env-file .env \
      -v "$(pwd)/.env:/app/.env" \
      ring-snapshot-proxy npm run setup
```

If you have multiple cameras: setup will display a numbered list and you pick one. Re-run setup anytime to pick a different camera.

### 5) Persisting refresh tokens (recommended)

Persist Ring refresh tokens across restarts by mounting a small local data directory.
Ring refresh tokens rotate automatically. Persisting them avoids needing to re-run setup unless Ring explicitly revokes access.

Create a local data directory:
```bash
    mkdir -p data
```

Run the service with the data volume mounted:
```bash
    docker run -d --name ring-snapshot-proxy \
      --restart unless-stopped \
      -p 3000:3000 \
      --env-file .env \
      -v "$(pwd)/data:/data" \
      ring-snapshot-proxy npm start
```

The latest refresh token will be written to:
```bash
    ./data/ring-state.json
```
Re-run `npm run setup` only if authentication fails or the token is revoked.

---

## Test locally

Health check (no auth):

    curl http://localhost:3000/health

Snapshot (low-res):

    curl -u Shalala:change-me -I http://localhost:3000/ring/snapshot.jpg

Frame (high-res):

    curl -u Shalala:change-me -I http://localhost:3000/ring/frame.jpg

Save a frame locally:

    curl -u Shalala:change-me -o frame.jpg http://localhost:3000/ring/frame.jpg

---

## Exposing publicly (testing)
Run this on an always-on host (Pi/VM), then expose port 3000 using a tunnel (ngrok dev domain / Cloudflare Tunnel).

Provide:

- Snapshot URL:
  - https://ip-address/ring/snapshot.jpg (fast/low-res)
  - https://ip-address/ring/frame.jpg (slow/high-res)

- Basic Auth credentials (if enabled):
  - BASIC_AUTH_USER / BASIC_AUTH_PASS

---

## Notes & limitations

- /ring/frame.jpg is cached to avoid repeated stream startups.
- Ring refresh tokens can rotate or be revoked.
- If auth fails after a restart, re-run setup (npm run setup) to refresh .env.
- Intended for internal use and experimentation.

## Troubleshooting

### Basic Auth changes not taking effect

If you update `BASIC_AUTH_USER` or `BASIC_AUTH_PASS` in `.env` and authentication still behaves as if the old credentials are in use, this is expected Docker behavior.

Docker only reads environment variables **when the container is created**. Restarting a container (`docker restart`) does **not** reload updated `.env` values.

Fix:

- Stop and remove the container
- Recreate it using the updated `.env`

Example:

    docker stop ring-snapshot-proxy
    docker rm ring-snapshot-proxy

    docker run -d --name ring-snapshot-proxy \
      --restart unless-stopped \
      -p 3000:3000 \
      --env-file .env \
      -v "$(pwd)/data:/data" \
      ring-snapshot-proxy npm start

Browsers may also cache Basic Auth credentials aggressively. If credentials were changed, test using `curl` or an incognito/private browser window.

---

### /ring/snapshot.jpg returns 502

If `/ring/snapshot.jpg` returns `502 Bad Gateway`, this is commonly caused by **motion detection being disabled** on the Ring camera.

Ring’s snapshot API is tied to motion settings. If motion detection or recording is turned off (or disabled by Modes), snapshots are not available.

Fix options:

- Enable Motion Detection / Record Motion for the camera in the Ring app
- Check that the current Ring Mode (Home/Away/Disarmed) allows motion for the camera

If you do not want to enable motion detection, use:

    /ring/frame.jpg

This endpoint pulls a frame from a live stream and does **not** depend on motion settings. It is slower/heavier than snapshots, but more reliable in restricted configurations.

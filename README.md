# Tesla Cast

Self-hosted iPhone → Tesla-browser screen sharing over real WebRTC. No native
app on either device, no fake "screen sharing" UI — the video only appears
because an actual `RTCPeerConnection` carrying a real captured `MediaStream`
is negotiated between the two browsers.

## Quick start (nothing to configure)

This zip already includes all dependencies and a working `.env` — you do not
need to run `npm install` or edit any file.

- **Mac/Linux:** double-click `start.sh` (or run `./start.sh` in a terminal)
- **Windows:** double-click `start.bat`
- **Any server/VPS:** upload the whole folder, then run `node server/index.js`
  (or use Docker — see "Production deployment" below)

That's it — it starts on `http://localhost:3000`. Open `/receiver` on the
Tesla and `/send` on your phone.

**The one thing no zip file can configure away:** WebRTC and screen capture
only work over a *secure* connection (HTTPS) once two separate physical
devices are involved — `http://localhost` is a browser-granted exception for
testing on one machine, but a phone talking to your computer's LAN IP, or a
Tesla talking to a plain `http://` server, will be blocked by the browser
itself, not by this app. For real use between your phone and the car, put
this behind HTTPS — see "Production deployment" for the exact commands
(it's one `certbot` command with a free domain, or one `docker compose up`
if you already have a reverse proxy with HTTPS in front of it).

```
Tesla browser  ── open ──▶  /receiver   (gets a 4-digit pairing code + QR)
Phone/laptop   ── open ──▶  /send       (enters the code, or scans the QR)
                                │
                    WebSocket signaling (this server)
                                │
                    WebRTC offer/answer/ICE exchange
                                │
                  ─── media flows peer-to-peer (or via TURN) ───▶
                                │
                     Tesla browser displays the stream
```

The Node server **never touches the video**. It only relays small JSON
signaling messages over WebSocket. Once WebRTC negotiates a path, the actual
audio/video goes directly between the two devices (through a TURN relay only
if you configure one and NAT requires it).

---

## Architecture summary

- **Backend**: Node.js + Express serves the static frontend and exposes three
  small JSON endpoints (`/api/config` for ICE servers, `/api/qr` for the
  pairing QR code, `/api/health` and `/api/stats` for diagnostics).
- **Signaling**: a `ws` WebSocket server at `/ws`. Each Tesla receiver that
  connects gets a random 4-digit code tied to a longer internal token
  (`server/pairing.js`). A phone/laptop "sender" enters that code to be
  linked to the same session (`server/signaling.js`), after which offer,
  answer, and ICE candidate messages are relayed 1:1 between the two sockets.
  Unpaired codes expire after 5 minutes; paired sessions are reaped after 30
  minutes of inactivity as a safety net; a dead-socket heartbeat runs every
  20s so a phone that drops off Wi-Fi doesn't leave a zombie session.
- **Media capture**: the sender page calls
  `navigator.mediaDevices.getDisplayMedia()` to capture the real screen (or
  `getUserMedia()` for the camera-cast fallback described below), then
  creates the `RTCPeerConnection`, adds the track, and sends the SDP offer.
  The receiver answers, exchanges ICE candidates, and renders the incoming
  track in a plain `<video autoplay playsinline muted>` element — no canvas
  re-encoding, so it can use hardware decode.
- **No recording, no relay of media through the server**: by design, the
  server process never receives a video byte. Nothing is written to disk.

---

## Known limitations (read this before you rely on it in the car)

**iOS Safari cannot do in-page screen capture today.** `getDisplayMedia()` —
the API this whole "cast the phone's actual screen" idea depends on — is not
exposed to a normal webpage in Safari or in any other iOS browser, because
every iOS browser is required to use WebKit. This has been WebKit's
documented status for years, and it's still what MDN, caniuse, and Apple's own
Safari 26/27 release notes reflect as of this writing (Sep 2026). There's one
unverified, single-source GitHub report claiming it now works on iOS 27; it's
uncorroborated by any official Apple/WebKit changelog, so this project does
not assume it and instead **detects capability at runtime**:

- On a browser that *does* support `getDisplayMedia()` (desktop Chrome,
  desktop Safari, desktop Firefox, Android Chrome), Start Screen Sharing does
  real full-screen mirroring today — this is the fully working path.
- On a browser that doesn't (currently iOS Safari, and Chrome/Firefox for
  iOS since they're WebKit under the hood), the sender page **says so
  explicitly** instead of pretending, and offers an honestly-labeled
  **"Cast Camera Instead"** fallback using `getUserMedia()` — that streams
  the phone's rear camera to the Tesla screen. This is not screen mirroring
  and the UI never claims it is.
- If Apple does add `getDisplayMedia()` support to a future iOS Safari
  release, no code changes are needed here — the capability check in
  `public/send.js` will pick it up automatically the next time a phone
  running that version opens `/send`.

**If you specifically need true full-screen iPhone mirroring today**, the
only technically legitimate way to get it without a native app is via
**AirPlay**, which is a system-level protocol, not something a webpage can
become a receiver for on its own. The real architecture for that is:

```
iPhone (native Control Center → Screen Mirroring)
        │  AirPlay (Bonjour/mDNS discovery + RAOP/mirroring protocol)
        ▼
A small AirPlay-receiver daemon on your server
  (e.g. UxPlay — github.com/FDH2/UxPlay — an open-source, actively
  maintained AirPlay 1/2 mirroring receiver built on GStreamer)
        │  decoded H.264 frames (e.g. piped to an appsink / named pipe)
        ▼
A bridge process that re-publishes those frames as a WebRTC track
(e.g. GStreamer's webrtcbin, or ffmpeg → a small WHIP/WebRTC ingest)
        │
        ▼
This project's Tesla receiver page displays it exactly like any other
WebRTC stream — no changes needed on the /receiver side.
```

That's a legitimate, non-trivial integration (UxPlay alone is a substantial
C/GStreamer project) and is intentionally **out of scope for this repo** —
reimplementing Apple's AirPlay mirroring/pairing protocol from scratch is not
something to bolt onto a Node/Express signaling server. If you want this
path, run UxPlay as a sidecar service and write a small bridge script that
feeds its output into a second `RTCPeerConnection` on the server side using
one of the Node WebRTC bindings (e.g. `werift` or `node-datachannel`); the
receiver page here doesn't care where the WebRTC offer comes from.

**Other real constraints, honestly stated:**

- **Audio**: video-only by default (per the intended safe default). Neither
  `getDisplayMedia` tab/window audio nor system audio is captured from iOS at
  all today.
- **DRM/protected content**: neither this app nor any browser API can or
  should capture DRM-protected video (Netflix, Apple TV+, etc.) during screen
  share — the OS blacks it out. This is expected platform behavior, not a bug
  here.
- **Tesla browser WebRTC support** varies by vehicle software version. This
  app is deliberately lightweight (no framework, one `<video>` element, no
  canvas compositing) to give it the best chance, but you should run the
  `/diagnostics` page from the actual car before relying on this.
- **NAT traversal**: works peer-to-peer via STUN in most home/office
  networks. In-car LTE/cellular modems and some hotel/corporate Wi-Fi can
  block the direct path — configure `TURN_SERVER`/`TURN_USERNAME`/
  `TURN_PASSWORD` in `.env` if `/diagnostics` shows STUN connectivity but
  the actual call still fails to connect.

---

## Project structure

```
tesla-cast/
├── server/
│   ├── index.js       # Express app, static hosting, /api/* routes
│   ├── signaling.js    # WebSocket signaling relay
│   └── pairing.js      # In-memory pairing-code session store + expiry
├── public/
│   ├── index.html       # Landing page
│   ├── receiver.html/.js  # Tesla-side receiver UI + WebRTC answerer
│   ├── send.html/.js       # Phone-side sender UI + capability detection + WebRTC offerer
│   ├── diagnostics.html/.js # Capability/network/server checks
│   └── style.css          # Shared dark, high-contrast, automotive-style UI
├── test/
│   └── signaling.test.js  # End-to-end WebSocket signaling test suite
├── node_modules/       # Dependencies, already installed — no `npm install` needed
├── start.sh              # Double-click/run to start on Mac/Linux
├── start.bat             # Double-click to start on Windows
├── .env                  # Ready-to-use config (blank PUBLIC_URL = auto-detect)
├── .env.example           # Same options, documented, as a clean reference
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## Running it locally (manual/advanced)

The `start.sh` / `start.bat` scripts above are the easiest path. If you'd
rather run things by hand (e.g. you're editing code):

```bash
npm install          # only needed if you deleted node_modules
npm run dev            # starts on http://localhost:3000
```

`.env` already ships with working defaults — `PUBLIC_URL` is left blank
on purpose so the server auto-detects the right base URL from each request
(see `server/index.js`). Only fill it in if you need to force a specific
external domain (e.g. it differs from what your reverse proxy reports).
`.env.example` documents every option with comments if you want a clean
reference copy.

Open `http://localhost:3000/receiver` in one tab and
`http://localhost:3000/send` in another (or on your phone, if it's on the
same network and you use your machine's LAN IP instead of localhost — see
the HTTPS note below).

> **HTTPS note:** WebRTC and `getDisplayMedia()` both require a secure
> context. `http://localhost` is exempt for local development, but a phone
> on your LAN talking to `http://<your-LAN-IP>:3000` is **not** — Safari and
> Chrome will refuse to expose capture APIs. For real testing across two
> devices, either use `https://localhost` via a local reverse proxy/tunnel
> (e.g. `ngrok http 3000`, or `mkcert` + a local reverse proxy), or deploy to
> a real HTTPS domain (see below) and test against that.

---

## Automated tests

`test/signaling.test.js` runs real WebSocket clients against a running
server and exercises the full pairing/signaling relay: code assignment,
successful pairing, offer/answer/ICE relay, stats relay, invalid codes,
double-pairing rejection, and disconnect propagation in both directions.

```bash
npm start &                # or: node server/index.js
sleep 1
node test/signaling.test.js
```

All 17 assertions pass against this build. This covers the signaling layer
exhaustively; it does **not** simulate real browser `getDisplayMedia()` /
`RTCPeerConnection` media negotiation, since that requires an actual browser
engine. Use `/diagnostics` plus the manual test matrix below for that.

### Manual test matrix (do this before trusting it in the car)

- [ ] Desktop Chrome (sender) → Tesla browser (receiver) — full screen share
- [ ] Android Chrome (sender) → Tesla browser (receiver) — full screen share
- [ ] iPhone Safari (sender) → Tesla browser (receiver) — confirm it shows
      the "Screen Sharing Unavailable" message and the camera-cast fallback
      works
- [ ] iPhone Safari (sender) → desktop Chrome (receiver) — same as above
- [ ] Sender taps "Stop Sharing" — receiver returns to waiting state with a
      fresh code
- [ ] Receiver taps "Disconnect" — sender is told and returns to the pairing
      screen
- [ ] Turn off Wi-Fi on the sender mid-share, turn it back on — connection
      should show "interrupted… reconnecting" rather than hard-failing
- [ ] Rotate the phone during a share — video should NOT stretch; black bars
      are fine, cropping is not
- [ ] Enter a wrong code — clear error, no crash
- [ ] Wait 5+ minutes without pairing — code expires, receiver silently gets
      a fresh one
- [ ] Open two Tesla receiver tabs — confirm each gets its own code and a
      sender only ever lands on the one it paired with
- [ ] Deny the screen-share permission prompt — clear "permission denied"
      message, retry works

---

## Production deployment

The included `.env` already has `PUBLIC_URL` blank, which is fine even in
production — the server reads the correct scheme/host from the incoming
request (and from `X-Forwarded-Proto`/`X-Forwarded-Host` if you're behind the
Nginx config below). Set `PUBLIC_URL` explicitly only if your proxy setup
doesn't forward those headers, or you want to force a specific domain.

### Option A — Docker (recommended)

```bash
docker compose up -d --build
```

That's the whole command — `.env` is already filled in with working
defaults. Add `TURN_*` values to `.env` first only if you know you'll need a
TURN server (see the TURN section below). This builds the image from the
included `Dockerfile` and runs it on port 3000 inside the container (mapped
to 3000 on the host — change the left side of the `ports:` mapping in
`docker-compose.yml` if you need a different host port).

### Option B — Plain Ubuntu + Nginx + Let's Encrypt

```bash
# On the server:
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
# Upload/extract this project to, say, /opt/tesla-cast, then:
cd /opt/tesla-cast
node server/index.js    # dependencies are already bundled in node_modules/
                          # or run under systemd/pm2 for restarts — see below
```

Nginx reverse proxy config (`/etc/nginx/sites-available/tesla-cast`):

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # required for the /ws WebSocket
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tesla-cast /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.example.com   # issues + auto-renews HTTPS
```

Run the Node process under a supervisor so it survives reboots/crashes:

```bash
# systemd unit at /etc/systemd/system/tesla-cast.service
[Unit]
Description=Tesla Cast
After=network.target

[Service]
WorkingDirectory=/path/to/tesla-cast
ExecStart=/usr/bin/node server/index.js
EnvironmentFile=/path/to/tesla-cast/.env
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now tesla-cast
```

### TURN (only if needed)

If `/diagnostics` shows STUN connectivity but real calls between two devices
still fail to connect (common on some carrier-grade NAT/cellular networks),
run a TURN server such as [coturn](https://github.com/coturn/coturn) and set
in `.env`:

```env
TURN_SERVER=turn:your-turn-domain.example.com:3478
TURN_USERNAME=some-username
TURN_PASSWORD=some-password
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Screen Sharing Unavailable" on iPhone | Expected — see Known Limitations above. Use "Cast Camera Instead" or the AirPlay-bridge architecture. |
| Sender never reaches "Connected" | Usually NAT traversal. Check `/diagnostics` → STUN connectivity; if it fails, configure TURN. |
| Video is black but "Connected" | Confirm the source content isn't DRM-protected — the OS blocks capture of that regardless of this app. |
| QR code doesn't load | `PUBLIC_URL` in `.env` is wrong/unreachable from the phone — the QR just encodes `PUBLIC_URL + /send?code=...`. |
| WebSocket won't connect in production | Confirm your reverse proxy forwards the `Upgrade`/`Connection` headers (see the Nginx config above) and that you're on HTTPS (`wss://`, not `ws://`). |
| Works on Wi-Fi, fails on the car's cellular connection | Configure a TURN server; carrier NATs are frequently symmetric and block direct P2P. |

---

## Security & privacy notes

- Pairing codes are 4 digits, random, and expire after 5 minutes if unused.
- No video or audio is ever written to disk or passed through the server —
  only signaling messages (SDP/ICE, both tiny JSON blobs) touch the backend.
- Sessions are destroyed on disconnect; a fresh code is issued immediately
  after so a stale code can't be reused to hijack a new session.
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` are
  set on all responses. Add your own rate limiting in front of `/api/*` and
  `/ws` (e.g. at the Nginx/CDN layer) if exposing this publicly rather than
  on a private/VPN network.

# SIP WS↔UDP Gateway

The Dinstar UC200 Pro only speaks SIP over UDP/TCP/TLS (confirmed from
Dinstar's own manuals/datasheet — no WebSocket/WSS/WebRTC support). The
Chrome extension can only speak SIP-over-WebSocket + WebRTC media (browsers
can't open raw UDP sockets). This gateway bridges the two: a small Asterisk
instance that registers to the UC200 Pro as a normal UDP extension (201) on
one side, and exposes a `wss://` endpoint the extension registers to on the
other, bridging calls between them (see `asterisk/extensions.conf.example`).

Codecs are pinned to G.711 (ulaw/alaw) on both legs so no transcoding is
needed — Chrome's WebRTC stack negotiates PCMU/PCMA natively.

## Critical prerequisite: network reachability

**The UC200 Pro is at a private LAN address (`192.168.0.110`).** Wherever
this gateway runs, it must be able to reach that address directly on port
5060/UDP. Two ways to satisfy that:

1. **Run it on the same LAN as the UC200 Pro** (a machine/mini-PC/Raspberry
   Pi on your local network), then expose its WSS port to the internet
   (port-forward + a domain, or a reverse tunnel like Cloudflare Tunnel) so
   the Chrome extension — which runs on whatever machine you're browsing
   from — can reach it from anywhere.
2. **Run it on your Hostinger VPS** (alongside your other Coolify-managed
   services) with a **site-to-site VPN (e.g. WireGuard) back to the LAN**
   the UC200 Pro sits on, so the VPS can route to `192.168.0.110`. This
   keeps the gateway on your existing infra but adds a VPN hop to set up
   and keep alive.

Pick whichever matches your actual network. If you're only testing from a
machine already on the same LAN as the UC200 Pro, you can skip the
internet-facing exposure step entirely for now and just point the extension
at `wss://<gateway-LAN-ip>:8088/ws` with a self-signed cert accepted
manually in Chrome (dev-only; use a real cert once you're ready for
outside-the-LAN access).

## Setup

1. Copy the example configs and fill in the placeholders:
   ```
   cp asterisk/pjsip.conf.example asterisk/pjsip.conf
   cp asterisk/extensions.conf.example asterisk/extensions.conf
   cp asterisk/http.conf.example asterisk/http.conf
   cp asterisk/rtp.conf.example asterisk/rtp.conf
   cp .env.example .env
   ```
   In `asterisk/pjsip.conf`:
   - `CHANGE_ME_UC200_PASSWORD` → extension 201's SIP password (same one
     used in MicroSIP's Password field).
   - `CHANGE_ME_BROWSER_PASSWORD` → a new password you choose for the
     browser-facing account (`browser-ext`).
   - Replace `192.168.0.110` / `201` if your extension number or the
     PBX's LAN IP differ.

   In `.env`, set `GATEWAY_DOMAIN` to the domain you'll point at this
   gateway (only needed if using the Traefik labels in
   `docker-compose.yml` — remove/adjust those labels if you're fronting
   this a different way).

2. Deploy `docker-compose.yml` (as a Coolify "Docker Compose" resource, or
   `docker compose up -d` directly on whichever host satisfies the
   reachability requirement above).

3. Point the extension's account settings at this gateway instead of the
   UC200 Pro directly:
   - **SIP URI**: `browser-ext@<gateway-domain-or-LAN-ip>`
   - **Password**: the `browser-ext` password you set above
   - **WSS server**: `wss://<gateway-domain>/ws` (or
     `wss://<gateway-LAN-ip>:8088/ws` for LAN-only testing — Asterisk's
     built-in HTTP server serves the WebSocket at `/ws`)

## Verifying it works

- `docker compose logs -f asterisk` and watch for `Registered SIP 'uc200'`
  (or similar) shortly after startup — confirms Asterisk registered to the
  UC200 Pro as extension 201.
- From the extension popup, Save & Register against the gateway — status
  should flip to `registered`.
- Dial another UC200 Pro extension from the popup, and dial extension 201
  from another phone/MicroSIP registered to the UC200 Pro, to test both
  call directions.

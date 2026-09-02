# Gateway debugging status

Live notes on the WS↔UDP gateway bridging the Chrome extension (browser-ext,
registered as extension 201) to the Dinstar UC200 Pro. Update this file as
issues are found/fixed so a new session can pick up without re-deriving
context. Test topology: extension 201 (this Chrome extension) and the
Asterisk gateway both run on the same Windows PC (`192.168.0.201`); extension
203 is a separate PC running MicroSIP, registered directly to the UC200 Pro.

## Solved

1. **REGISTER 404 Not Found** — the AOR object name must equal the account
   identity in the REGISTER's To-header, not merely be listed in the
   endpoint's `aors=`. Fixed by naming the browser-side AOR section
   `[browser-ext]`, matching the endpoint name.
2. **Auth username mismatch** — extension's "Auth username" field and
   Asterisk's `[browser-ext-auth]` `username=` must match (both `browser-ext`
   now). Asterisk identifies the endpoint by the digest Authorization
   header's username.
3. **`chrome.storage` undefined in the offscreen document** — a known MV3
   limitation. Fixed by proxying account reads/writes through the background
   service worker (`bg-get-account`/`bg-save-account` messages).
4. **Mic permission prompt closing the popup** — MV3 popups close on focus
   loss, which cancels the getUserMedia prompt. Fixed via a dedicated
   `mic-permission.html` tab opened from the popup.
5. **`contact_user` on the wrong PJSIP object** — it was set on the `[uc200]`
   *endpoint*, which has no effect on the outbound REGISTER. It belongs on
   `[uc200-registration]` (`type=registration`) — that's what actually builds
   the REGISTER's Contact header. Confirmed via
   `pjsip show registration uc200-registration` showing the Contact user
   change from a random string to `201` after moving it. This was needed so
   the UC200 Pro routes inbound calls to 201 to the right place instead of
   failing dialplan lookup with "extension not found in context
   'from-uc200'" trying `'s'`.
6. **Outbound INVITEs leaking the Docker bridge IP** — Asterisk's
   `transport-udp` had no `external_signaling_address`/
   `external_media_address`, so outbound INVITEs to the UC200 Pro carried
   `Contact: <sip:201@172.18.0.2:5060>` and `c=IN IP4 172.18.0.2` (Asterisk's
   internal Docker network IP, unreachable from the UC200 Pro). This is the
   most likely cause of the UC200 Pro's `403 Forbidden` on browser→203
   calls. Fixed by adding `external_signaling_address`,
   `external_media_address` (set to the gateway host's real LAN IP,
   `192.168.0.201` in this setup) to `[transport-udp]`. **First attempt at
   `local_net` was wrong**: setting it to `172.16.0.0/12` +
   `192.168.0.0/16` made Asterisk classify the UC200 Pro (`192.168.0.110`,
   inside that /16) as "local," which made it skip the external-address
   rewrite entirely for calls to it — confirmed live: the Docker bridge IP
   (`172.18.0.2`) kept leaking into the Contact/SDP even with
   `external_signaling_address`/`external_media_address` set and verified
   loaded via `pjsip show transport transport-udp`. `local_net` must only
   cover the network Asterisk's own container interface sits on (the Docker
   bridge, `172.16.0.0/12`), not the host LAN — anything reached through the
   container's NAT, including same-LAN devices like the UC200 Pro, is
   external from Asterisk's point of view. Fixed by dropping the
   `192.168.0.0/16` line. **Not yet re-verified against a live call** —
   next step: retest 201→203 and confirm the INVITE's Contact/SDP now show
   `192.168.0.201` instead of `172.18.0.2`, and that the UC200 Pro stops
   sending 403.
7. **WebSocket "Not connected" mid-call / on REGISTER refresh** — SIP.js had
   no `keepAliveInterval`, so the idle WSS connection between the browser and
   the gateway was being silently dropped (no close frame received) after
   ~15-25s idle, likely reaped by Docker Desktop's port-forwarding / Windows
   Firewall / router NAT. Fixed by setting `transportOptions.keepAliveInterval
   = 15` in `src/offscreen/sip-client.ts`. **Not yet re-verified** after a
   longer idle period since the fix was deployed.
8. Also switched the extension's SIP URI / WSS server from `localhost` to
   the host's real LAN IP (`192.168.0.201`) as a general Docker-Desktop-on-
   Windows stability improvement (localhost port-forwarding through the
   WSL2 relay is less reliable for long-lived connections than the real LAN
   adapter).

## Solved (2026-09-02/03 session)

9. **Both call directions failing with a port mismatch traced to Docker
   Desktop's own networking, not Asterisk config.** The UC200 Pro's own
   "SIP Extension > Status" page consistently showed extension 201's
   REGISTER arriving from a different random ephemeral port every time
   (59435, 58525, 51858, 56286...) instead of :5060, even after confirming
   Asterisk's transport-udp binds 0.0.0.0:5060 and declares :5060 in every
   header via external_signaling_address. Investigated and ruled out, in
   order: Docker bridge NAT port-publish conflict, WSL2's own NAT layer
   (tried enabling WSL2 "mirrored" networking mode — this actually broke
   LAN-facing port publishing entirely, since Docker Desktop's port-forward
   proxy doesn't bind the real Windows LAN adapter under mirrored mode;
   reverted), and Docker "host" network mode (only reaches the WSL2 VM's
   own namespace on Windows, not reachable from Chrome; reverted). Direct
   evidence (Windows netstat showing the outbound UDP flow to
   192.168.0.110:5060 relayed through the same PID as Docker's own
   port-forward listener, using a fresh ephemeral port each time) confirmed
   the real cause: Docker Desktop's Windows port-forwarding proxy relays
   container-outbound UDP through a new ephemeral local port per flow
   rather than preserving the container's bound port — a structural
   limitation of Docker Desktop's networking, not something fixable via
   Asterisk's pjsip.conf alone (tried `symmetric_transport=yes` on
   transport-udp — loads fine but doesn't change this, since the issue is
   in the port-forward proxy, not pjproject's socket handling).
   **Working fix**: added `qualify_frequency=30` to `[uc200-aor]` in
   pjsip.conf. Asterisk now sends an OPTIONS ping to the UC200 Pro every
   30s, keeping that specific outbound "flow" continuously warm in Docker's
   relay so the ephemeral port stays pinned between registration and an
   actual call attempt (rather than expiring and rotating to a new port on
   each new flow). Confirmed live: both directions worked in the same test
   session immediately after this — 201->203 connected with two-way audio,
   and 203->201 correctly rang through to the browser extension's
   registered contact (Asterisk's own log showed "Nobody picked up in
   30000 ms" only because the popup UI wasn't open to show the incoming
   call, not a signaling failure — see #10).
10. **Incoming calls only appeared if the extension popup happened to
    already be open — no alert otherwise.** `src/offscreen/main.ts`
    broadcasts `state-changed` via `chrome.runtime.sendMessage`, which only
    reaches currently-open listeners; with the popup closed, a ringing
    call's state change went nowhere and the call silently timed out after
    30s with no indication anything happened. Fixed by having the always-
    running background service worker (`src/background/main.ts`) listen for
    `state-changed` directly and drive a `chrome.notifications` alert (with
    Answer/Reject buttons that message the offscreen document directly, no
    popup needed) plus a toolbar badge, cleared once the call leaves the
    ringing state. Required adding actual icon assets
    (`public/icons/icon{16,48,128}.png`, generated via PowerShell/
    System.Drawing — none existed before) since `chrome.notifications`
    requires a valid `iconUrl`.

## Solved (cont'd)

11. **203 → 201 INVITEs silently dropped in the browser with no error
    visible anywhere except the offscreen document's own console.**
    Asterisk's logs showed the INVITE being sent to the extension's
    WebSocket successfully ("Called PJSIP/browser-ext") with no error, so
    everything looked fine gateway-side — but nothing happened in the
    browser, not even the automatic "100 Trying" SIP.js normally sends
    immediately. Root cause, found by opening DevTools on the offscreen
    document specifically (`chrome://extensions` → SIP Phone card →
    "offscreen.html" link → Console tab) at the moment of a call: SIP.js's
    parser was rejecting the `From` header — `From: "Hasib"
    <sip:203@4023bc114763>` — because `4023bc114763` (the Docker
    container's own hostname/ID) starts with a digit, and SIP's strict URI
    grammar requires a hostname's top label to start with a letter. The
    `[browser-ext]` endpoint in pjsip.conf had no `from_domain` set, so
    Asterisk fell back to the container's hostname when building the From
    header for the leg it originates toward the browser extension (i.e.
    UC200 Pro calls forwarded here). Fixed by adding
    `from_domain=192.168.0.201` to `[browser-ext]`, matching what was
    already done for `[uc200]`.

## Status: both directions confirmed working end-to-end (2026-09-02)

- **201 → 203**: confirmed live with two-way audio.
- **203 → 201**: confirmed live — the browser extension now shows the
  incoming call and connects with two-way audio.
- M1's exit criteria (two-way audio, both directions, on real hardware) is
  met.

Desktop-notification UX for incoming calls (background service worker +
`chrome.notifications`, added in this session — see `src/background/
main.ts`) confirmed working with the popup closed: notification pops up
and answering connects the call. M1 is fully done.

## Diagnostic commands used throughout

```
docker compose exec asterisk asterisk -rx "pjsip set logger on"
docker compose logs -f asterisk
docker compose exec asterisk asterisk -rx "pjsip show registration uc200-registration"
docker compose exec asterisk asterisk -rx "pjsip show transport transport-udp"
docker compose exec asterisk asterisk -rx "pjsip show endpoint browser-ext"
docker compose exec asterisk asterisk -rx "pjsip show endpoint uc200"
```

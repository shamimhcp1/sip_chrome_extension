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

## Still open / needs a fresh live test

- **201 → 203 (outbound call)**: last confirmed failure was `403 Forbidden`
  from the UC200 Pro (`Reason: Q.850;cause=21`), received right after
  `100 Trying`, with the INVITE's Contact/SDP showing the Docker-internal IP
  (issue #6 above). Needs retest now that `external_signaling_address`/
  `external_media_address` are confirmed loaded — if 403 persists with the
  correct LAN IP now showing in the INVITE, the cause is something else
  (e.g. a call-permission/ACL setting on the UC200 Pro side — checked the
  Classification Tag tab, it was empty/unconfigured, so if it recurs, compare
  extension 201's Setting-tab fields against 203's Setting tab in detail,
  looking for any permission/CoS field not visible in the list view).
- **203 → 201 (inbound call)**: last attempt produced **no Asterisk log at
  all** — the call never reached the gateway. Not yet diagnosed why. Needs:
  confirm 203 actually dialed `201` and see what happened on the MicroSIP
  side (busy tone? no route? silent failure?), and capture
  `pjsip set logger on` output on the Asterisk side during the attempt to
  see if anything arrives from `192.168.0.110:5060` at all.
- Once both directions connect, still need to confirm actual two-way audio
  (not just signaling) to close out M1's exit criteria.

## Diagnostic commands used throughout

```
docker compose exec asterisk asterisk -rx "pjsip set logger on"
docker compose logs -f asterisk
docker compose exec asterisk asterisk -rx "pjsip show registration uc200-registration"
docker compose exec asterisk asterisk -rx "pjsip show transport transport-udp"
docker compose exec asterisk asterisk -rx "pjsip show endpoint browser-ext"
docker compose exec asterisk asterisk -rx "pjsip show endpoint uc200"
```

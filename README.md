# sip_chrome_extension

A MicroSIP-inspired SIP softphone built as a Chrome (MV3) extension —
WebRTC + SIP-over-WSS. See [PRD.md](./PRD.md) for background, architecture,
and milestones.

## Development

```
npm install
npm run build      # one-off build -> dist/
npm run dev        # rebuild on file changes -> dist/
npm run typecheck
```

## Loading the extension locally

1. `npm run build`
2. Go to `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the `dist/` folder

## Status

**M0 — scaffold**: MV3 manifest, popup, background service worker, and
offscreen document wired up with a basic ping/pong message round-trip.

**M1 — single account, basic calling**: SIP.js integrated in the offscreen
document (`src/offscreen/sip-client.ts`). Popup has an account form (SIP
URI, password, WSS server, display name) that registers via
`account-register`, a dial pad, and answer/reject/hangup controls. Account
config persists in `chrome.storage.local` and auto-registers when the
offscreen document (re)loads.

Before testing a call, click **Enable microphone** once in the popup — the
offscreen document has no UI to show the browser's mic permission prompt,
so that grant has to come from a visible extension page first (it then
applies to the whole extension origin).

Not yet implemented: hold/mute/DTMF/transfer, call history, contacts,
multiple accounts (all M2+).

**Testing against the Dinstar UC200 Pro**: confirmed it has no WSS/WebRTC
support (UDP/TCP/TLS only), so the extension can't register to it directly.
A WS↔UDP gateway (Asterisk) bridges the two — see
[gateway/README.md](./gateway/README.md) for setup, and point the
extension's WSS server field at the gateway instead of the PBX.

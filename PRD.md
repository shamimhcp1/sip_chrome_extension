# PRD: SIP Chrome Extension (MicroSIP-inspired)

## 1. Background & Problem Statement

The goal is a MicroSIP-like SIP softphone that runs as a Chrome extension.
`MicroSIP3.22.12.exe` (a Windows NSIS installer, ~9.4MB) was used as the
reference for feature/UX parity. This repo starts empty, so this PRD is the
spec before any code is written.

### 1.1 What MicroSIP is (reference analysis)

The installer's outer NSIS stub is a plain Win32 PE with no readable payload
(LZMA-compressed inside NSIS), but the stub's manifest/imports (`ADVAPI32`,
`COMCTL32`, `GDI32`, `KERNEL32`, `SHELL32`, `USER32`, `ole32`, `asInvoker`
execution level) confirm a native Win32 GUI app — consistent with MicroSIP's
documented design:

- **Core engine**: PJSIP/PJSUA2 (C library) — SIP signaling (UAC/UAS) and
  RTP/RTCP media natively over raw UDP/TCP/TLS, with STUN/TURN/ICE for NAT
  traversal and SRTP/TLS for encryption.
- **UI**: native Win32, thin layer over PJSIP.
- **Codecs**: G.711 (PCMU/PCMA), G.722, G.729 (licensed plugin), GSM, iLBC,
  Opus, Speex — negotiated via SDP.
- **Feature set**: multiple SIP accounts; register/dial/answer/hangup;
  hold/mute; blind & attended transfer; DTMF (RFC2833 + SIP INFO); call
  history; contacts/address book; ringtone & audio device selection;
  auto-answer; presence/BLF; `microsip://` URI handler for click-to-call.

### 1.2 Why the desktop architecture can't be ported 1:1

A Chrome (MV3) extension cannot open raw UDP/TCP sockets or link native code
like PJSIP, so it cannot do RFC3261 SIP-over-UDP/TCP or raw RTP the way
MicroSIP does. Decision: build on **WebRTC + SIP-over-WebSocket (WSS)** —
the same approach used by FreePBX UCP and 3CX WebClient — rather than a
native-messaging-host bridge to a real PJSIP process. This keeps it a pure,
installable extension with no companion app, at the cost of requiring the
target SIP server/PBX to expose a WSS transport with a valid TLS
certificate, since MV3 extensions run in a secure context.

## 2. Goals / Non-Goals

**Goals**: register one or more SIP accounts over WSS, place/receive calls
via WebRTC audio, and match MicroSIP's day-to-day softphone workflow
(dial pad, call controls, contacts, history) inside a Chrome extension —
plus two capabilities MicroSIP itself doesn't have, since they're
browser-native: (1) automatically detect and highlight phone numbers found
on any web page with click-to-dial, and (2) surface incoming-call alerts
even when the extension popup is closed.

**Non-Goals (v1)**: video calling, G.729/legacy codec support (browser codec
set only — Opus/G.711 via WebRTC), presence/BLF, native UDP/TCP SIP
transport, non-Chromium browsers.

## 3. Milestones

### M0 — Project scaffold
- MV3 `manifest.json`, permissions (`storage`, `offscreen`, `notifications`),
  build tooling (plain TS/Vite or esbuild — no framework needed for a popup
  this size).
- Offscreen document wired up (MV3 service workers can't hold a live
  `RTCPeerConnection`/audio context across popup close, so the offscreen
  document owns the SIP session for the extension's lifetime).
- **Exit criteria**: extension loads unpacked in Chrome, shows an empty
  popup, no console errors.

### M1 — Single account, basic calling
- Integrate SIP.js (or JsSIP) in the offscreen document.
- Account settings UI (SIP URI, password, WSS server) stored in
  `chrome.storage.local`.
- REGISTER against a WSS-capable PBX; dial pad; outbound call; answer/reject
  inbound call; hangup; live call timer; basic ringtone.
- **Exit criteria**: successful two-way audio call against the target PBX
  (both directions), verified manually.

### M2 — Core call controls (MicroSIP parity)
- Hold/resume, mute, DTMF (RFC2833 via WebRTC + SIP INFO fallback), blind
  transfer, attended transfer.
- Call history (chrome.storage, persisted per account).
- **Exit criteria**: each control verified against a real PBX call.

### M3 — Contacts & multi-account
- Address book (add/edit/delete, click-to-call).
- Multiple SIP accounts with independent registration state, account
  switcher in the UI.
- **Exit criteria**: two accounts registered simultaneously; calling from
  contacts works for either account.

### M4 — Polish & MicroSIP-specific niceties
- Audio input/output device selection, ringtone selection, auto-answer,
  incoming-call desktop notification with answer/decline actions
  (`chrome.notifications`), minimize-to-tray-equivalent (badge/notification
  since extensions have no tray icon).
- Optional: omnibox keyword or context-menu click-to-call for
  `tel:`/`sip:` links on web pages (parity with MicroSIP's URI handler).
- **Exit criteria**: feature checklist against MicroSIP's UI reviewed;
  packaged `.zip` ready for Chrome Web Store submission or private
  distribution.

### M5 — Content script: number highlighting & click-to-dial
- **Content script** injected on all pages (`matches: ["<all_urls>"]`,
  or scoped to user-enabled sites if an opt-in allowlist is preferred) that:
  - Walks page text nodes and detects phone-number-shaped substrings via
    regex/heuristics (`libphonenumber-js` is worth using instead of a
    hand-rolled regex, since it handles international formats, extensions,
    and false-positive avoidance — e.g. not matching dates, order numbers,
    zip codes).
  - Wraps each match in a `<span>`/inline element with a distinct style
    (underline + highlight color) without disturbing page layout or
    breaking existing event handlers on surrounding text.
  - Adds a click handler on each highlighted number that triggers a call
    via message passing to the offscreen document (reusing the same
    calling path as the popup, not duplicating SIP logic in the content
    script).
  - Uses a debounced `MutationObserver` to catch numbers added after
    initial load (SPAs, infinite scroll), skipping already-processed nodes.
  - Skips non-visible/non-text contexts: `<script>`/`<style>` contents,
    `contenteditable` regions, and form `<input>` values.
- **Settings**: a toggle in the extension's options/popup to enable/disable
  highlighting globally or per-site.
- Existing native `tel:` links on pages are also intercepted for
  click-to-call.
- **Exit criteria**: on a handful of real-world test pages (a company
  contact page, a directory listing, a forum thread with numbers in plain
  text), numbers are correctly detected and highlighted with low
  false-positive rate, and clicking one originates a call through the
  account configured in M1.

## 4. Installation Notes (for testing each milestone)

**Loading the extension locally (Chrome/Edge, Chromium-based):**
1. Build the extension (`npm run build`, once M0 scaffolding exists) —
   produces a `dist/` folder with `manifest.json`.
2. Go to `chrome://extensions`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**, select the `dist/` folder.
5. Pin the extension icon; click it to open the popup and configure a SIP
   account (SIP URI, password, WSS server URL). Against the UC200 Pro this
   points at the `gateway/` bridge, not the PBX directly — see Section 5.

**PBX-side prerequisites (needed before M1 can be tested end-to-end):**
- A SIP account on a server that exposes a **WSS** transport with a valid
  (non-self-signed, or locally-trusted) TLS certificate — self-signed certs
  will be silently blocked by Chrome's secure-context checks unless
  manually trusted first.
- CORS/ICE: if the PBX is behind NAT, a STUN server (and TURN if symmetric
  NAT is involved) must be reachable from the browser.
- Have the SIP credentials (extension number, secret, WSS URL) ready before
  M1 testing.

**Distribution later:** unpacked/dev mode is sufficient through M4; Chrome
Web Store publishing (or self-hosted `.crx` for internal use) is out of
scope until it's ready to ship externally.

## 5. Target PBX: Dinstar UC200 Pro — confirmed no WSS, gateway required

**Confirmed** (Dinstar's own UC200 Pro manuals/datasheet, and the device's
own admin UI — SIP Trunk settings only offer UDP/TCP/TLS transport, same as
MicroSIP's client-side Transport dropdown): the UC200 Pro has **no
WebSocket/WSS/WebRTC support**, on either its trunk side or its extension
side. This was the one hard blocker called out for the chosen WebRTC-only
architecture, and it's real — the extension cannot register against the
UC200 Pro directly.

**Decision**: deploy a small **Asterisk-based WS↔UDP gateway**
(`gateway/`) in front of the UC200 Pro. Asterisk registers to the UC200 Pro
as a normal UDP extension (the existing extension 201) on one side, and
exposes a `wss://.../ws` endpoint the Chrome extension registers to on the
other, bridging calls between them. Codecs are pinned to G.711 (ulaw/alaw)
on both legs so no transcoding is needed. See `gateway/README.md` for the
full setup (Docker Compose + Asterisk config templates).

**Network prerequisite**: the UC200 Pro is at a private LAN address
(`192.168.0.110`), so the gateway must run somewhere that can reach it
directly — either a machine on that same LAN (exposed to the internet via
port-forward or a tunnel), or the Hostinger VPS with a site-to-site VPN
back to that LAN. This is a deployment decision for you to make based on
your actual network, documented with both options in `gateway/README.md`.

STUN/TURN is not needed for this path — Asterisk terminates WebRTC media
directly (no ICE negotiation needed beyond mDNS/host candidates on a LAN or
between the extension and a public gateway) and speaks plain RTP to the
UC200 Pro.

## 6. Persistent Background Operation

The extension must stay registered and alert on incoming calls even while
the popup is closed (not just while the UI is open). This makes the
**offscreen document + background SIP registration** (scoped in M0/M1)
mandatory from day one — the offscreen document holds the live
`RTCPeerConnection`/registration for the extension's whole lifetime, and
`chrome.notifications` surfaces incoming-call alerts (with Answer/Decline
actions) regardless of popup state.

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
offscreen document wired up with a basic ping/pong message round-trip. No
SIP functionality yet — that starts at M1.

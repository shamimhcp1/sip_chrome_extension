// Offscreen document: will host the SIP.js UserAgent, registration, and
// active RTCPeerConnection from M1 onward. For M0 this just proves the
// document loads and can talk back to the background service worker.

import { sendMessage } from "../lib/messaging";

void sendMessage({ type: "offscreen-ready" });
console.log("[offscreen] loaded");

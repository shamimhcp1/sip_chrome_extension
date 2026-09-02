// Popup UI. M0: just proves round-trip messaging to the background worker.
// M1 replaces this with account setup + dial pad.

import { sendMessage, type ExtensionMessage } from "../lib/messaging";

const statusEl = document.getElementById("status");

sendMessage({ type: "ping" }).then((response) => {
  const reply = response as ExtensionMessage;
  if (statusEl && reply?.type === "pong") {
    statusEl.textContent = "Scaffold running (M0) — background worker responding.";
  }
});

// Offscreen document: hosts the SipClient (UserAgent, registration, active
// RTCPeerConnection) for the extension's whole lifetime, independent of
// whether the popup is open.

import type { SipAccountConfig } from "../lib/account";
import { sendMessage, type ExtensionMessage, type AckResponse } from "../lib/messaging";
import { SipClient } from "./sip-client";

// Offscreen documents don't reliably get direct chrome.storage access (a
// known Chrome limitation), so account storage goes through the background
// service worker instead, which always has full API access.
async function bgGetAccount(): Promise<SipAccountConfig | null> {
  const response = (await sendMessage({ type: "bg-get-account" })) as { account: SipAccountConfig | null };
  return response.account;
}

async function bgSaveAccount(account: SipAccountConfig): Promise<void> {
  await sendMessage({ type: "bg-save-account", account });
}

// SIP.js's internal transport keeps retrying a failed WSS connection in
// the background and can reject those retry promises without anything in
// our code awaiting them — left unhandled, that's what flags this
// extension with errors in chrome://extensions even though we're already
// surfacing registration failures through state.registration === "failed".
window.addEventListener("unhandledrejection", (event) => {
  console.warn("[offscreen] unhandled rejection (likely SIP.js transport retry)", event.reason);
  event.preventDefault();
});

const client = new SipClient();

client.onStateChange((state) => {
  void sendMessage({ type: "state-changed", state }).catch(() => {
    // No listener open (popup closed) — fine, popup re-fetches with
    // "get-state" the next time it opens.
  });
});

async function autoRegister(): Promise<void> {
  const account = await bgGetAccount();
  if (!account) return;
  await client.register(account);
}
autoRegister().catch((error) => {
  console.error("[offscreen] auto-register failed", error);
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  const respond = (response: AckResponse) => sendResponse(response);

  switch (message.type) {
    case "account-register":
      void (async () => {
        await bgSaveAccount(message.account);
        try {
          await client.register(message.account);
          respond({ ok: true });
        } catch (error) {
          respond({ ok: false, error: String(error) });
        }
      })();
      return true;

    case "account-unregister":
      void client.unregister().then(() => respond({ ok: true }));
      return true;

    case "call-dial":
      void client
        .dial(message.target)
        .then(() => respond({ ok: true }))
        .catch((error) => respond({ ok: false, error: String(error) }));
      return true;

    case "call-answer":
      void client
        .answer()
        .then(() => respond({ ok: true }))
        .catch((error) => respond({ ok: false, error: String(error) }));
      return true;

    case "call-reject":
      void client.reject().then(() => respond({ ok: true }));
      return true;

    case "call-hangup":
      void client.hangup().then(() => respond({ ok: true }));
      return true;

    case "get-state":
      sendResponse({ state: client.getState() });
      return false;

    default:
      return false;
  }
});

void sendMessage({ type: "offscreen-ready" }).catch(() => {});
console.log("[offscreen] loaded");

// MV3 service worker. Owns lifecycle of the offscreen document, which is
// where the live SIP registration / RTCPeerConnection will live (M1+) since
// service workers can't hold those across the popup closing.

import { getAccount, saveAccount } from "../lib/account";
import type { ExtensionMessage } from "../lib/messaging";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Hold the live SIP registration and call audio (RTCPeerConnection).",
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreenDocument();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreenDocument();
});

chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  if (message.type === "offscreen-ready") {
    console.log("[background] offscreen document ready");
    return false;
  }
  if (message.type === "ping") {
    sendResponse({ type: "pong" } satisfies ExtensionMessage);
    return true;
  }
  if (message.type === "bg-get-account") {
    void getAccount().then((account) => sendResponse({ account }));
    return true;
  }
  if (message.type === "bg-save-account") {
    void saveAccount(message.account).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

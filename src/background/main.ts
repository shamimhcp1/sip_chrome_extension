// MV3 service worker. Owns lifecycle of the offscreen document, which is
// where the live SIP registration / RTCPeerConnection will live (M1+) since
// service workers can't hold those across the popup closing.
//
// It also owns the incoming-call notification: the offscreen document
// broadcasts state-changed over chrome.runtime.sendMessage, which only
// reaches listeners that are currently open. The popup isn't open most of
// the time, so without this, a ringing call is silently dropped — nothing
// tells the user a call is happening. The service worker is always
// listening (MV3 wakes it for runtime messages), so it drives a desktop
// notification + toolbar badge instead, with Answer/Reject buttons that
// message the offscreen document directly — no popup needs to be open to
// answer a call.

import { getAccount, saveAccount } from "../lib/account";
import type { ExtensionMessage } from "../lib/messaging";
import type { StateSnapshot } from "../lib/sip-state";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const INCOMING_CALL_NOTIFICATION_ID = "incoming-call";

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

function clearIncomingCallAlert(): void {
  void chrome.notifications.clear(INCOMING_CALL_NOTIFICATION_ID);
  void chrome.action.setBadgeText({ text: "" });
}

function showIncomingCallAlert(remoteIdentity: string): void {
  void chrome.action.setBadgeText({ text: "IN" });
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  // create() replaces an existing notification with the same id rather than
  // stacking a duplicate, so repeated state-changed events for the same
  // still-ringing call are harmless.
  void chrome.notifications.create(INCOMING_CALL_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Incoming call",
    message: remoteIdentity,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: "Answer" }, { title: "Reject" }],
  });
}

function handleStateChanged(state: StateSnapshot): void {
  if (state.call?.direction === "incoming" && state.call.state === "ringing") {
    showIncomingCallAlert(state.call.remoteIdentity);
  } else {
    clearIncomingCallAlert();
  }
}

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (notificationId !== INCOMING_CALL_NOTIFICATION_ID) return;
  const type = buttonIndex === 0 ? "call-answer" : "call-reject";
  void chrome.runtime.sendMessage({ type } satisfies ExtensionMessage);
  void chrome.notifications.clear(INCOMING_CALL_NOTIFICATION_ID);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== INCOMING_CALL_NOTIFICATION_ID) return;
  void chrome.action.openPopup();
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
  if (message.type === "state-changed") {
    handleStateChanged(message.state);
    return false;
  }
  return false;
});

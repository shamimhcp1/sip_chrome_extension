// Message protocol between popup, background, and the offscreen document.
// Sent via chrome.runtime.sendMessage, which broadcasts to every extension
// page with an onMessage listener — no explicit routing needed.

import type { SipAccountConfig } from "./account";
import type { StateSnapshot } from "./sip-state";

export type ExtensionMessage =
  | { type: "offscreen-ready" }
  | { type: "ping" }
  | { type: "pong" }
  | { type: "account-register"; account: SipAccountConfig }
  | { type: "account-unregister" }
  | { type: "call-dial"; target: string }
  | { type: "call-answer" }
  | { type: "call-reject" }
  | { type: "call-hangup" }
  | { type: "get-state" }
  | { type: "state-changed"; state: StateSnapshot }
  // Internal: offscreen -> background storage proxy. Offscreen documents
  // don't reliably get direct chrome.storage access (a known Chrome
  // limitation), so storage reads/writes for the account route through
  // the background service worker instead, which always has full API access.
  | { type: "bg-get-account" }
  | { type: "bg-save-account"; account: SipAccountConfig };

export interface AckResponse {
  ok: boolean;
  error?: string;
}

export function sendMessage(message: ExtensionMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

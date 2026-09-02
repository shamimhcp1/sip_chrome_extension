// Shared message protocol between popup, background, and the offscreen
// document. Extended in later milestones (account/call control messages).

export type ExtensionMessage = { type: "offscreen-ready" } | { type: "ping" } | { type: "pong" };

export function sendMessage(message: ExtensionMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

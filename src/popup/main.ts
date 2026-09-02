import { getAccount, type SipAccountConfig } from "../lib/account";
import { clearCallHistory, getCallHistory, type CallHistoryEntry } from "../lib/call-history";
import { sendMessage, type AckResponse, type ExtensionMessage } from "../lib/messaging";
import type { StateSnapshot } from "../lib/sip-state";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const uriInput = el<HTMLInputElement>("uri");
const passwordInput = el<HTMLInputElement>("password");
const wssServerInput = el<HTMLInputElement>("wssServer");
const displayNameInput = el<HTMLInputElement>("displayName");
const authUsernameInput = el<HTMLInputElement>("authUsername");
const accountError = el<HTMLParagraphElement>("account-error");
const regStatus = el<HTMLSpanElement>("reg-status");

const targetInput = el<HTMLInputElement>("target");
const callStatus = el<HTMLParagraphElement>("call-status");
const incomingRow = el<HTMLDivElement>("incoming-row");

const muteBtn = el<HTMLButtonElement>("mute");
const holdBtn = el<HTMLButtonElement>("hold");
const dtmfGrid = el<HTMLDivElement>("dtmf-grid");
const transferTargetInput = el<HTMLInputElement>("transfer-target");
const blindTransferBtn = el<HTMLButtonElement>("blind-transfer");
const attendedTransferStartBtn = el<HTMLButtonElement>("attended-transfer-start");
const attendedTransferRow = el<HTMLDivElement>("attended-transfer-row");
const attendedTransferCompleteBtn = el<HTMLButtonElement>("attended-transfer-complete");
const attendedTransferCancelBtn = el<HTMLButtonElement>("attended-transfer-cancel");
const attendedTransferStatus = el<HTMLParagraphElement>("attended-transfer-status");
const historyList = el<HTMLUListElement>("history-list");

let currentState: StateSnapshot = { registration: "unregistered", call: null };

function readAccountForm(): SipAccountConfig {
  return {
    uri: uriInput.value.trim(),
    password: passwordInput.value,
    wssServer: wssServerInput.value.trim(),
    displayName: displayNameInput.value.trim() || undefined,
    authorizationUsername: authUsernameInput.value.trim() || undefined,
  };
}

function fillAccountForm(account: SipAccountConfig): void {
  uriInput.value = account.uri;
  passwordInput.value = account.password;
  wssServerInput.value = account.wssServer;
  displayNameInput.value = account.displayName ?? "";
  authUsernameInput.value = account.authorizationUsername ?? "";
}

function setControlsEnabled(enabled: boolean): void {
  muteBtn.disabled = !enabled;
  holdBtn.disabled = !enabled;
  for (const button of dtmfGrid.querySelectorAll<HTMLButtonElement>(".dtmf-key")) button.disabled = !enabled;
  blindTransferBtn.disabled = !enabled;
  attendedTransferStartBtn.disabled = !enabled || !!currentState.call?.attendedTransfer;
}

function renderState(state: StateSnapshot): void {
  currentState = state;
  regStatus.textContent = state.registration;
  regStatus.className = state.registration;

  const call = state.call;
  if (!call) {
    callStatus.textContent = "No active call";
    incomingRow.hidden = true;
    attendedTransferRow.hidden = true;
    attendedTransferStatus.textContent = "";
    setControlsEnabled(false);
    return;
  }

  incomingRow.hidden = call.direction !== "incoming" || call.state !== "ringing";

  const badges = [call.muted ? "muted" : null, call.held ? "held" : null].filter(Boolean).join(", ");
  callStatus.textContent = `${call.direction} call — ${call.state}${badges ? ` (${badges})` : ""} — ${call.remoteIdentity}`;

  muteBtn.textContent = call.muted ? "Unmute" : "Mute";
  holdBtn.textContent = call.held ? "Resume" : "Hold";
  setControlsEnabled(call.state === "established");

  if (call.attendedTransfer) {
    attendedTransferRow.hidden = false;
    attendedTransferCompleteBtn.disabled = call.attendedTransfer.state !== "established";
    attendedTransferStatus.textContent = `Consulting ${call.attendedTransfer.remoteIdentity} — ${call.attendedTransfer.state}`;
  } else {
    attendedTransferRow.hidden = true;
    attendedTransferStatus.textContent = "";
  }
}

function formatHistoryEntry(entry: CallHistoryEntry): string {
  const time = new Date(entry.startedAt).toLocaleString();
  const arrow = entry.direction === "incoming" ? "←" : "→";
  return `${arrow} ${entry.remoteIdentity} · ${entry.outcome} · ${time}`;
}

async function renderHistory(): Promise<void> {
  const entries = await getCallHistory();
  historyList.innerHTML = "";
  for (const entry of entries.slice(0, 20)) {
    const li = document.createElement("li");
    li.textContent = formatHistoryEntry(entry);
    historyList.appendChild(li);
  }
}

async function refreshState(): Promise<void> {
  const response = (await sendMessage({ type: "get-state" })) as { state: StateSnapshot } | undefined;
  if (response) renderState(response.state);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "state-changed") {
    const hadCall = !!currentState.call;
    renderState(message.state);
    if (hadCall && !message.state.call) void renderHistory();
  }
});

el<HTMLButtonElement>("save-register").addEventListener("click", async () => {
  accountError.textContent = "";
  const account = readAccountForm();
  if (!account.uri || !account.wssServer) {
    accountError.textContent = "SIP URI and WSS server are required.";
    return;
  }
  const response = (await sendMessage({ type: "account-register", account })) as AckResponse;
  if (!response.ok) accountError.textContent = response.error ?? "Registration failed.";
});

el<HTMLButtonElement>("unregister").addEventListener("click", () => {
  void sendMessage({ type: "account-unregister" });
});

el<HTMLButtonElement>("request-mic").addEventListener("click", () => {
  // Requesting getUserMedia directly from the popup fails with
  // "Permission dismissed" — the popup closes the instant Chrome's
  // permission prompt steals focus, cancelling it. Doing this from a
  // regular tab instead avoids that; the grant then applies to the whole
  // extension origin, offscreen document included.
  chrome.tabs.create({ url: chrome.runtime.getURL("mic-permission.html") });
});

el<HTMLButtonElement>("call").addEventListener("click", async () => {
  const target = targetInput.value.trim();
  if (!target) return;
  const response = (await sendMessage({ type: "call-dial", target })) as AckResponse;
  if (!response.ok) callStatus.textContent = `Call failed: ${response.error ?? ""}`;
});

el<HTMLButtonElement>("hangup").addEventListener("click", () => {
  void sendMessage({ type: "call-hangup" });
});

el<HTMLButtonElement>("answer").addEventListener("click", () => {
  void sendMessage({ type: "call-answer" });
});

el<HTMLButtonElement>("reject").addEventListener("click", () => {
  void sendMessage({ type: "call-reject" });
});

muteBtn.addEventListener("click", () => {
  const muted = !(currentState.call?.muted ?? false);
  void sendMessage({ type: "call-set-mute", muted });
});

holdBtn.addEventListener("click", async () => {
  const held = !(currentState.call?.held ?? false);
  const response = (await sendMessage({ type: "call-set-hold", held })) as AckResponse;
  if (!response.ok) callStatus.textContent = `Hold failed: ${response.error ?? ""}`;
});

for (const button of dtmfGrid.querySelectorAll<HTMLButtonElement>(".dtmf-key")) {
  button.addEventListener("click", () => {
    const tone = button.dataset.tone;
    if (tone) void sendMessage({ type: "call-dtmf", tone });
  });
}

blindTransferBtn.addEventListener("click", async () => {
  const target = transferTargetInput.value.trim();
  if (!target) return;
  const response = (await sendMessage({ type: "call-transfer-blind", target })) as AckResponse;
  if (!response.ok) callStatus.textContent = `Transfer failed: ${response.error ?? ""}`;
});

attendedTransferStartBtn.addEventListener("click", async () => {
  const target = transferTargetInput.value.trim();
  if (!target) return;
  const response = (await sendMessage({ type: "call-transfer-attended-start", target })) as AckResponse;
  if (!response.ok) callStatus.textContent = `Attended transfer failed: ${response.error ?? ""}`;
});

attendedTransferCompleteBtn.addEventListener("click", async () => {
  const response = (await sendMessage({ type: "call-transfer-attended-complete" })) as AckResponse;
  if (!response.ok) callStatus.textContent = `Complete transfer failed: ${response.error ?? ""}`;
});

attendedTransferCancelBtn.addEventListener("click", () => {
  void sendMessage({ type: "call-transfer-attended-cancel" });
});

el<HTMLButtonElement>("history-clear").addEventListener("click", async () => {
  await clearCallHistory();
  await renderHistory();
});

void (async () => {
  const account = await getAccount();
  if (account) fillAccountForm(account);
  await refreshState();
  await renderHistory();
})();

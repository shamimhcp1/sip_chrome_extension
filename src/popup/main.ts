import { getAccount, type SipAccountConfig } from "../lib/account";
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

function renderState(state: StateSnapshot): void {
  regStatus.textContent = state.registration;
  regStatus.className = state.registration;

  if (!state.call) {
    callStatus.textContent = "No active call";
    incomingRow.hidden = true;
    return;
  }

  incomingRow.hidden = state.call.direction !== "incoming" || state.call.state !== "ringing";
  callStatus.textContent = `${state.call.direction} call — ${state.call.state} — ${state.call.remoteIdentity}`;
}

async function refreshState(): Promise<void> {
  const response = (await sendMessage({ type: "get-state" })) as { state: StateSnapshot } | undefined;
  if (response) renderState(response.state);
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "state-changed") renderState(message.state);
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

el<HTMLButtonElement>("request-mic").addEventListener("click", async () => {
  accountError.textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    accountError.textContent = "Microphone access granted.";
  } catch (error) {
    accountError.textContent = `Microphone permission denied: ${String(error)}`;
  }
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

void (async () => {
  const account = await getAccount();
  if (account) fillAccountForm(account);
  await refreshState();
})();

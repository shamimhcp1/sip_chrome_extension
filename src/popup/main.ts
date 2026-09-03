import { getAccount, type SipAccountConfig } from "../lib/account";
import { getCallHistory, clearCallHistory, type CallHistoryEntry } from "../lib/call-history";
import { sendMessage, type AckResponse, type ExtensionMessage } from "../lib/messaging";
import type { CallSnapshot, StateSnapshot } from "../lib/sip-state";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type TabName = "dialer" | "contacts" | "history" | "settings" | "account";

// ---------- Header ----------
const acctDot = el<HTMLSpanElement>("acct-dot");
const acctChipText = el<HTMLSpanElement>("acct-chip-text");

// ---------- Shell / tabs ----------
const tabbar = el<HTMLElement>("tabbar");
const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".tab"));
const panels: Record<TabName, HTMLElement> = {
  dialer: el("panel-dialer"),
  contacts: el("panel-contacts"),
  history: el("panel-history"),
  settings: el("panel-settings"),
  account: el("panel-account"),
};
const callView = el<HTMLDivElement>("call-view");

// ---------- Dialer ----------
const targetInput = el<HTMLInputElement>("target");
const callBtn = el<HTMLButtonElement>("call");
const callError = el<HTMLParagraphElement>("call-error");

// ---------- Account ----------
const uriInput = el<HTMLInputElement>("uri");
const passwordInput = el<HTMLInputElement>("password");
const wssServerInput = el<HTMLInputElement>("wssServer");
const displayNameInput = el<HTMLInputElement>("displayName");
const authUsernameInput = el<HTMLInputElement>("authUsername");
const regStatusDot = el<HTMLSpanElement>("reg-status-dot");
const regStatusText = el<HTMLSpanElement>("reg-status-text");
const accountError = el<HTMLParagraphElement>("account-error");

// ---------- History ----------
const historyList = el<HTMLDivElement>("history-list");
const historyEmpty = el<HTMLDivElement>("history-empty");

// ---------- Call: ringing ----------
const callRinging = el<HTMLElement>("call-ringing");
const ringingName = el<HTMLDivElement>("ringing-name");
const ringingSub = el<HTMLDivElement>("ringing-sub");

// ---------- Call: connecting ----------
const callConnecting = el<HTMLElement>("call-connecting");
const connectingEyebrowText = el<HTMLSpanElement>("connecting-eyebrow-text");
const connectingName = el<HTMLDivElement>("connecting-name");
const connectingSub = el<HTMLDivElement>("connecting-sub");

// ---------- Call: active ----------
const callActive = el<HTMLElement>("call-active");
const activeStatusPill = el<HTMLSpanElement>("active-status-pill");
const activeStatusText = el<HTMLSpanElement>("active-status-text");
const activeName = el<HTMLDivElement>("active-name");
const activeSub = el<HTMLDivElement>("active-sub");
const activeControls = el<HTMLDivElement>("active-controls");
const muteBtn = el<HTMLButtonElement>("mute");
const muteLbl = el<HTMLSpanElement>("mute-lbl");
const holdBtn = el<HTMLButtonElement>("hold");
const holdLbl = el<HTMLSpanElement>("hold-lbl");
const openKeypadBtn = el<HTMLButtonElement>("open-keypad");
const openBlindTransferBtn = el<HTMLButtonElement>("open-blind-transfer");
const openAttendedTransferBtn = el<HTMLButtonElement>("open-attended-transfer");
const blindTransferPanel = el<HTMLDivElement>("blind-transfer-panel");
const blindTransferTargetInput = el<HTMLInputElement>("blind-transfer-target");
const attendedTransferPanel = el<HTMLDivElement>("attended-transfer-panel");
const attendedTransferTargetInput = el<HTMLInputElement>("attended-transfer-target");
const callKeypad = el<HTMLDivElement>("call-keypad");
const dtmfEntered = el<HTMLDivElement>("dtmf-entered");
const callConsult = el<HTMLDivElement>("call-consult");
const consultHeldName = el<HTMLDivElement>("consult-held-name");
const consultName = el<HTMLDivElement>("consult-name");
const consultStatusText = el<HTMLSpanElement>("consult-status-text");
const attendedTransferCompleteBtn = el<HTMLButtonElement>("attended-transfer-complete");
const hangupBtn = el<HTMLButtonElement>("hangup");

let currentState: StateSnapshot = { registration: "unregistered", call: null };
let accountUri: string | null = null;
let activeTab: TabName = "dialer";
let keypadOpen = false;
let transferMode: "blind" | "attended" | null = null;
let dtmfDigits = "";

// ---------- Account form ----------
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
  accountUri = account.uri;
}

// ---------- Header + tabs ----------
function renderHeader(): void {
  acctDot.className = "acct-dot" + (currentState.registration !== "unregistered" ? ` ${currentState.registration}` : "");
  acctChipText.textContent = accountUri ?? "No account";

  regStatusDot.className = "status-dot" + (currentState.registration !== "unregistered" ? ` ${currentState.registration}` : "");
  regStatusText.textContent = currentState.registration;
}

function showTab(tab: TabName): void {
  activeTab = tab;
  for (const btn of tabButtons) btn.classList.toggle("active", btn.dataset.tab === tab);
  for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== tab;
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab as TabName | undefined;
    if (tab) showTab(tab);
  });
}

// ---------- Dialer keypad (compose a number before calling) ----------
for (const btn of document.querySelectorAll<HTMLButtonElement>("#dial-keypad .key")) {
  btn.addEventListener("click", () => {
    const digit = btn.dataset.digit;
    if (digit) targetInput.value += digit;
    targetInput.focus();
  });
}

// ---------- Render: shell vs. full-bleed call screens ----------
function renderShell(): void {
  callView.hidden = true;
  tabbar.hidden = false;
  showTab(activeTab);
}

function renderDtmfEntered(): void {
  dtmfEntered.textContent = dtmfDigits;
  if (!dtmfDigits) dtmfEntered.innerHTML = '<span class="ph">Enter DTMF digits&hellip;</span>';
}

function renderCall(call: CallSnapshot): void {
  tabbar.hidden = true;
  for (const panel of Object.values(panels)) panel.hidden = true;
  callView.hidden = false;

  callRinging.hidden = true;
  callConnecting.hidden = true;
  callActive.hidden = true;

  const subLine = accountUri ? `via ${accountUri}` : "";

  if (call.direction === "incoming" && call.state === "ringing") {
    callRinging.hidden = false;
    ringingName.textContent = call.remoteIdentity;
    ringingSub.textContent = subLine;
    return;
  }

  if (call.state === "connecting") {
    callConnecting.hidden = false;
    connectingEyebrowText.textContent = call.direction === "outgoing" ? "Calling…" : "Connecting…";
    connectingName.textContent = call.remoteIdentity;
    connectingSub.textContent = subLine;
    return;
  }

  // Only "established" remains.
  callActive.hidden = false;
  activeName.textContent = call.remoteIdentity;
  activeSub.textContent = subLine;

  activeStatusPill.classList.toggle("held", call.held);
  activeStatusText.textContent = call.held ? "On hold" : "Established";

  muteBtn.classList.toggle("on", call.muted);
  muteLbl.textContent = call.muted ? "Unmute" : "Mute";
  holdBtn.classList.toggle("on", call.held);
  holdBtn.classList.toggle("held", call.held);
  holdLbl.textContent = call.held ? "Resume" : "Hold";

  const consulting = !!call.attendedTransfer;
  callKeypad.hidden = !keypadOpen || consulting;
  callConsult.hidden = !consulting;
  activeControls.hidden = keypadOpen || consulting;
  blindTransferPanel.hidden = transferMode !== "blind";
  attendedTransferPanel.hidden = transferMode !== "attended";

  if (consulting && call.attendedTransfer) {
    consultHeldName.textContent = call.remoteIdentity;
    consultName.textContent = call.attendedTransfer.remoteIdentity;
    consultStatusText.textContent = call.attendedTransfer.state === "established" ? "Connected" : "Ringing…";
    attendedTransferCompleteBtn.disabled = call.attendedTransfer.state !== "established";
  }
}

function renderState(state: StateSnapshot): void {
  currentState = state;
  renderHeader();
  if (state.call) {
    renderCall(state.call);
  } else {
    keypadOpen = false;
    transferMode = null;
    dtmfDigits = "";
    renderShell();
  }
}

// ---------- History ----------
const DIRECTION_ICON_PATH: Record<CallHistoryEntry["direction"], string> = {
  incoming: `<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M6 10c0 6 4 10 10 10v-2.6a1 1 0 0 0-.8-1l-2.4-.5a1 1 0 0 0-1 .4l-.8 1.1a9 9 0 0 1-4.4-4.4l1.1-.8a1 1 0 0 0 .4-1l-.5-2.4a1 1 0 0 0-1-.8H6Z"/>`,
  outgoing: `<path d="M20 4h-6"/><path d="M20 4v6"/><path d="M20 4l-7 7"/><path d="M6 10c0 6 4 10 10 10v-2.6a1 1 0 0 0-.8-1l-2.4-.5a1 1 0 0 0-1 .4l-.8 1.1a9 9 0 0 1-4.4-4.4l1.1-.8a1 1 0 0 0 .4-1l-.5-2.4a1 1 0 0 0-1-.8H6Z"/>`,
};

const OUTCOME_COLOR: Record<CallHistoryEntry["outcome"], string> = {
  answered: "var(--established)",
  missed: "var(--ringing)",
  failed: "var(--error)",
  rejected: "var(--text-secondary)",
  canceled: "var(--text-secondary)",
};

function escapeHtml(value: string): string {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function formatDuration(entry: CallHistoryEntry): string {
  if (!entry.answeredAt) return "";
  const totalSeconds = Math.round((entry.endedAt - entry.answeredAt) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

async function renderHistory(): Promise<void> {
  const entries = await getCallHistory();
  historyList.innerHTML = "";
  historyEmpty.hidden = entries.length > 0;
  historyList.hidden = entries.length === 0;

  for (const entry of entries.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "h-row";
    const time = new Date(entry.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    row.innerHTML = `
      <div class="h-dir" style="color:${OUTCOME_COLOR[entry.outcome]}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${DIRECTION_ICON_PATH[entry.direction]}</svg>
      </div>
      <div class="h-info">
        <div class="h-name">${escapeHtml(entry.remoteIdentity)}</div>
        <div class="h-meta">${formatDuration(entry)}</div>
      </div>
      <div class="h-right">
        <div class="h-time">${time}</div>
        <span class="tag ${entry.outcome}">${entry.outcome}</span>
      </div>`;
    historyList.appendChild(row);
  }
}

el<HTMLButtonElement>("history-clear").addEventListener("click", async () => {
  await clearCallHistory();
  await renderHistory();
});

// ---------- Messaging plumbing ----------
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

// ---------- Account actions ----------
el<HTMLButtonElement>("save-register").addEventListener("click", async () => {
  accountError.textContent = "";
  const account = readAccountForm();
  if (!account.uri || !account.wssServer) {
    accountError.textContent = "SIP URI and WSS server are required.";
    return;
  }
  const response = (await sendMessage({ type: "account-register", account })) as AckResponse;
  if (!response.ok) {
    accountError.textContent = response.error ?? "Registration failed.";
  } else {
    accountUri = account.uri;
    renderHeader();
  }
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

// ---------- Dialer actions ----------
callBtn.addEventListener("click", async () => {
  const target = targetInput.value.trim();
  if (!target) return;
  callError.textContent = "";
  const response = (await sendMessage({ type: "call-dial", target })) as AckResponse;
  if (!response.ok) callError.textContent = `Call failed: ${response.error ?? ""}`;
});

// ---------- Ringing / connecting actions ----------
el<HTMLButtonElement>("answer").addEventListener("click", () => {
  void sendMessage({ type: "call-answer" });
});

el<HTMLButtonElement>("reject").addEventListener("click", () => {
  void sendMessage({ type: "call-reject" });
});

el<HTMLButtonElement>("connecting-hangup").addEventListener("click", () => {
  void sendMessage({ type: "call-hangup" });
});

// ---------- Active-call actions ----------
hangupBtn.addEventListener("click", () => {
  void sendMessage({ type: "call-hangup" });
});

muteBtn.addEventListener("click", () => {
  const muted = !(currentState.call?.muted ?? false);
  void sendMessage({ type: "call-set-mute", muted });
});

holdBtn.addEventListener("click", async () => {
  const held = !(currentState.call?.held ?? false);
  const response = (await sendMessage({ type: "call-set-hold", held })) as AckResponse;
  if (!response.ok) console.error("Hold failed", response.error);
});

openKeypadBtn.addEventListener("click", () => {
  keypadOpen = true;
  dtmfDigits = "";
  renderDtmfEntered();
  if (currentState.call) renderCall(currentState.call);
});

el<HTMLButtonElement>("close-keypad").addEventListener("click", () => {
  keypadOpen = false;
  if (currentState.call) renderCall(currentState.call);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>("#dtmf-keypad .dtmf-key")) {
  btn.addEventListener("click", () => {
    const tone = btn.dataset.tone;
    if (!tone) return;
    dtmfDigits += tone;
    renderDtmfEntered();
    void sendMessage({ type: "call-dtmf", tone });
  });
}

// ---------- Transfer actions ----------
openBlindTransferBtn.addEventListener("click", () => {
  transferMode = transferMode === "blind" ? null : "blind";
  if (currentState.call) renderCall(currentState.call);
});

openAttendedTransferBtn.addEventListener("click", () => {
  transferMode = transferMode === "attended" ? null : "attended";
  if (currentState.call) renderCall(currentState.call);
});

el<HTMLButtonElement>("blind-transfer-cancel").addEventListener("click", () => {
  transferMode = null;
  if (currentState.call) renderCall(currentState.call);
});

el<HTMLButtonElement>("blind-transfer-send").addEventListener("click", async () => {
  const target = blindTransferTargetInput.value.trim();
  if (!target) return;
  const response = (await sendMessage({ type: "call-transfer-blind", target })) as AckResponse;
  if (!response.ok) {
    console.error("Blind transfer failed", response.error);
    return;
  }
  transferMode = null;
  blindTransferTargetInput.value = "";
});

el<HTMLButtonElement>("attended-transfer-cancel-start").addEventListener("click", () => {
  transferMode = null;
  if (currentState.call) renderCall(currentState.call);
});

el<HTMLButtonElement>("attended-transfer-start").addEventListener("click", async () => {
  const target = attendedTransferTargetInput.value.trim();
  if (!target) return;
  const response = (await sendMessage({ type: "call-transfer-attended-start", target })) as AckResponse;
  if (!response.ok) {
    console.error("Attended transfer failed", response.error);
    return;
  }
  transferMode = null;
  attendedTransferTargetInput.value = "";
});

el<HTMLButtonElement>("attended-transfer-cancel").addEventListener("click", () => {
  void sendMessage({ type: "call-transfer-attended-cancel" });
});

attendedTransferCompleteBtn.addEventListener("click", async () => {
  const response = (await sendMessage({ type: "call-transfer-attended-complete" })) as AckResponse;
  if (!response.ok) console.error("Complete transfer failed", response.error);
});

// ---------- Init ----------
void (async () => {
  const account = await getAccount();
  if (account) fillAccountForm(account);
  await refreshState();
  await renderHistory();
})();

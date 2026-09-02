// Persisted call log, shared by the offscreen document (writer, via the
// background proxy — see messaging.ts's "bg-add-call-history-entry") and the
// popup (reader — popups have full chrome.storage access, unlike offscreen
// documents, so they read/clear this directly).

import type { CallDirection } from "./sip-state";

export type CallOutcome = "answered" | "missed" | "rejected" | "canceled" | "failed";

export interface CallHistoryEntry {
  id: string;
  direction: CallDirection;
  remoteIdentity: string;
  startedAt: number;
  answeredAt: number | null;
  endedAt: number;
  outcome: CallOutcome;
}

const STORAGE_KEY = "callHistory";
const MAX_ENTRIES = 200;

export async function getCallHistory(): Promise<CallHistoryEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as CallHistoryEntry[] | undefined) ?? [];
}

export async function addCallHistoryEntry(entry: CallHistoryEntry): Promise<void> {
  const existing = await getCallHistory();
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
}

export async function clearCallHistory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}

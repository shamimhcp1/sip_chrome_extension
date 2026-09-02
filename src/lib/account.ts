// Persisted SIP account config, shared by popup (writer) and offscreen
// document (reader/registerer).

export interface SipAccountConfig {
  /** "extension@host", e.g. "1001@pbx.example.com" — no "sip:" prefix. */
  uri: string;
  password: string;
  /** e.g. "wss://pbx.example.com:8089/ws" */
  wssServer: string;
  displayName?: string;
  /** Defaults to the URI's user part if omitted. */
  authorizationUsername?: string;
}

const STORAGE_KEY = "sipAccount";

export async function getAccount(): Promise<SipAccountConfig | null> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result[STORAGE_KEY] as SipAccountConfig | undefined) ?? null;
}

export async function saveAccount(account: SipAccountConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: account });
}

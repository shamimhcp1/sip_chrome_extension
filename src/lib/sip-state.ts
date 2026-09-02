// State snapshot shape broadcast from the offscreen document (where the
// SipClient lives) to whichever extension pages are listening (popup).

export type RegistrationState = "unregistered" | "registering" | "registered" | "failed";
export type CallDirection = "incoming" | "outgoing";
export type CallPhase = "ringing" | "connecting" | "established";

export interface CallSnapshot {
  direction: CallDirection;
  state: CallPhase;
  remoteIdentity: string;
}

export interface StateSnapshot {
  registration: RegistrationState;
  call: CallSnapshot | null;
}

export const initialState: StateSnapshot = { registration: "unregistered", call: null };

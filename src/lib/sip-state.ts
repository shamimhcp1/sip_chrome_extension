// State snapshot shape broadcast from the offscreen document (where the
// SipClient lives) to whichever extension pages are listening (popup).

export type RegistrationState = "unregistered" | "registering" | "registered" | "failed";
export type CallDirection = "incoming" | "outgoing";
export type CallPhase = "ringing" | "connecting" | "established";

export interface AttendedTransferSnapshot {
  remoteIdentity: string;
  state: CallPhase;
}

export interface CallSnapshot {
  direction: CallDirection;
  state: CallPhase;
  remoteIdentity: string;
  muted: boolean;
  held: boolean;
  /** Set while a second, consultation call for an attended transfer is in progress. */
  attendedTransfer: AttendedTransferSnapshot | null;
}

export interface StateSnapshot {
  registration: RegistrationState;
  call: CallSnapshot | null;
}

export const initialState: StateSnapshot = { registration: "unregistered", call: null };

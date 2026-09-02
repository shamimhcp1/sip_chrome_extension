// Wraps SIP.js to register a single account over WSS and handle one call
// at a time (outbound and inbound), plus one concurrent consultation call
// while an attended transfer is in progress, with remote audio played
// through a hidden <audio> element that lives in the offscreen document.
//
// Microphone access: getUserMedia needs a permission grant on the
// extension's chrome-extension:// origin. The offscreen document has no UI
// to show a permission prompt, so the popup must trigger that prompt once
// (see popup/main.ts "request microphone access") before the first call —
// the grant then applies to this origin, including the offscreen document.

import {
  Inviter,
  Invitation,
  Registerer,
  RegistererState,
  Session,
  SessionState,
  UserAgent,
  UserAgentOptions,
  Web,
} from "sip.js";
import type { SipAccountConfig } from "../lib/account";
import type { CallHistoryEntry, CallOutcome } from "../lib/call-history";
import type { AttendedTransferSnapshot, CallSnapshot, StateSnapshot } from "../lib/sip-state";

type StateListener = (state: StateSnapshot) => void;
type HistoryListener = (entry: CallHistoryEntry) => void;

interface CallMeta {
  direction: "incoming" | "outgoing";
  remoteIdentity: string;
  startedAt: number;
  answeredAt: number | null;
  /** Set explicitly by our own hangup/reject/cancel actions; inferred otherwise. */
  outcome: CallOutcome | null;
}

function makeCallMeta(direction: "incoming" | "outgoing", remoteIdentity: string): CallMeta {
  return { direction, remoteIdentity, startedAt: Date.now(), answeredAt: null, outcome: null };
}

export class SipClient {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;

  private session: Inviter | Invitation | null = null;
  private callMeta: CallMeta | null = null;

  /** The consultation ("B") leg while an attended transfer is in progress. */
  private transferSession: Inviter | null = null;
  private transferMeta: CallMeta | null = null;

  private readonly remoteAudio: HTMLAudioElement;
  private state: StateSnapshot = { registration: "unregistered", call: null };
  private readonly listeners = new Set<StateListener>();
  private readonly historyListeners = new Set<HistoryListener>();

  constructor() {
    this.remoteAudio = document.createElement("audio");
    this.remoteAudio.autoplay = true;
    document.body.appendChild(this.remoteAudio);
  }

  getState(): StateSnapshot {
    return this.state;
  }

  onStateChange(listener: StateListener): void {
    this.listeners.add(listener);
  }

  /** Fired once per call (including the consultation leg of an attended transfer) when it ends. */
  onCallEnded(listener: HistoryListener): void {
    this.historyListeners.add(listener);
  }

  private setState(patch: Partial<StateSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private setCall(patch: Partial<CallSnapshot> | null): void {
    if (patch === null) {
      this.setState({ call: null });
      return;
    }
    this.setState({ call: { ...(this.state.call as CallSnapshot), ...patch } });
  }

  private emitHistoryEntry(entry: CallHistoryEntry): void {
    for (const listener of this.historyListeners) listener(entry);
  }

  private recordHistory(meta: CallMeta): void {
    const outcome: CallOutcome =
      meta.outcome ?? (meta.answeredAt ? "answered" : meta.direction === "incoming" ? "missed" : "failed");
    this.emitHistoryEntry({
      id: crypto.randomUUID(),
      direction: meta.direction,
      remoteIdentity: meta.remoteIdentity,
      startedAt: meta.startedAt,
      answeredAt: meta.answeredAt,
      endedAt: Date.now(),
      outcome,
    });
  }

  async register(account: SipAccountConfig): Promise<void> {
    await this.unregister();

    const uri = UserAgent.makeURI(`sip:${account.uri}`);
    if (!uri) throw new Error(`Invalid SIP URI: ${account.uri}`);

    const userAgentOptions: UserAgentOptions = {
      uri,
      displayName: account.displayName,
      authorizationUsername: account.authorizationUsername || uri.user,
      authorizationPassword: account.password,
      // Without a keepalive, an idle WebSocket gets silently dropped by
      // Docker Desktop's port-forwarding / Windows Firewall / router NAT
      // after a short idle timeout — confirmed live: SIP.js reported
      // "Not connected" on the next send after ~15-25s idle, with no close
      // frame ever received. A double-CRLF ping every 15s keeps the
      // connection (and any NAT/firewall state for it) alive.
      transportOptions: { server: account.wssServer, keepAliveInterval: 15 },
      delegate: {
        onInvite: (invitation) => this.handleIncomingCall(invitation),
      },
    };

    this.userAgent = new UserAgent(userAgentOptions);
    this.setState({ registration: "registering" });

    try {
      await this.userAgent.start();
      this.registerer = new Registerer(this.userAgent);
      this.registerer.stateChange.addListener((registererState) => {
        if (registererState === RegistererState.Registered) {
          this.setState({ registration: "registered" });
        } else if (registererState === RegistererState.Unregistered) {
          this.setState({ registration: "unregistered" });
        }
      });
      await this.registerer.register();
    } catch (error) {
      this.setState({ registration: "failed" });
      throw error;
    }
  }

  async unregister(): Promise<void> {
    await this.cancelAttendedTransfer();
    await this.hangup();
    if (this.registerer) {
      try {
        await this.registerer.unregister();
      } catch {
        // best-effort
      }
      this.registerer = null;
    }
    if (this.userAgent) {
      try {
        await this.userAgent.stop();
      } catch {
        // best-effort
      }
      this.userAgent = null;
    }
    this.setState({ registration: "unregistered" });
  }

  async dial(target: string): Promise<void> {
    if (!this.userAgent) throw new Error("Not registered");
    if (this.session) throw new Error("A call is already in progress");

    const targetUri = this.makeTargetUri(target);
    const inviter = new Inviter(this.userAgent, targetUri);
    this.session = inviter;
    this.callMeta = makeCallMeta("outgoing", target);
    this.setState({
      call: { direction: "outgoing", state: "connecting", remoteIdentity: target, muted: false, held: false, attendedTransfer: null },
    });
    this.wirePrimarySession(inviter, this.callMeta);
    await inviter.invite();
  }

  async answer(): Promise<void> {
    if (!(this.session instanceof Invitation)) return;
    this.setCall({ state: "connecting" });
    await this.session.accept();
  }

  async reject(): Promise<void> {
    if (!(this.session instanceof Invitation)) return;
    if (this.callMeta) this.callMeta.outcome = "rejected";
    await this.session.reject();
  }

  async hangup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    if (this.callMeta && !this.callMeta.answeredAt) {
      this.callMeta.outcome = session instanceof Inviter ? "canceled" : "rejected";
    }
    try {
      if (session instanceof Inviter && session.state === SessionState.Initial) {
        await session.cancel();
      } else if (session.state === SessionState.Established) {
        await session.bye();
      } else if (session instanceof Invitation) {
        await session.reject();
      }
    } catch {
      // best-effort — the Terminated state-change listener performs cleanup either way
    }
  }

  setMute(muted: boolean): void {
    const session = this.session;
    const call = this.state.call;
    if (!session || session.state !== SessionState.Established || !call) return;
    this.applyTrackState(session, call.held, muted);
    this.setCall({ muted });
  }

  async setHold(held: boolean): Promise<void> {
    const session = this.session;
    const call = this.state.call;
    if (!session || session.state !== SessionState.Established || !call) return;
    if (call.held === held) return;

    const reinviteOptions: Web.SessionDescriptionHandlerOptions = {
      ...(session.sessionDescriptionHandlerOptionsReInvite as Web.SessionDescriptionHandlerOptions),
      hold: held,
    };
    session.sessionDescriptionHandlerOptionsReInvite = reinviteOptions;

    // Optimistically apply so the UI and local tracks respond immediately.
    this.setCall({ held });
    this.applyTrackState(session, held, call.muted);
    try {
      await session.invite();
    } catch (error) {
      this.setCall({ held: !held });
      this.applyTrackState(session, !held, call.muted);
      throw error;
    }
  }

  /** Sends a DTMF tone via RTP (RFC 2833/4733); falls back to SIP INFO if the peer connection can't send it. */
  sendDtmf(tone: string): void {
    const session = this.session;
    if (!session || session.state !== SessionState.Established) throw new Error("No active call");
    if (!/^[0-9A-D#*]$/.test(tone)) throw new Error(`Invalid DTMF tone: ${tone}`);

    const sdh = session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    if (sdh?.sendDtmf(tone)) return;

    // As RFC 6086 notes, DTMF-via-INFO is not standardized but is widely
    // supported, and is the fallback of last resort when the peer
    // connection has no DTMF sender (e.g. no active audio sender).
    void session.info({
      requestOptions: {
        body: {
          contentDisposition: "render",
          contentType: "application/dtmf-relay",
          content: `Signal=${tone}\r\nDuration=2000`,
        },
      },
    });
  }

  async blindTransfer(target: string): Promise<void> {
    const session = this.session;
    if (!session || session.state !== SessionState.Established) throw new Error("No active call to transfer");
    const uri = this.makeTargetUri(target);
    await session.refer(uri);
    // MicroSIP-style blind transfer: drop our leg as soon as the far end
    // has accepted the REFER — the transferee's own UA carries the call
    // through to the target from here.
    await this.hangup();
  }

  async startAttendedTransfer(target: string): Promise<void> {
    if (!this.userAgent) throw new Error("Not registered");
    const primary = this.session;
    if (!primary || primary.state !== SessionState.Established) throw new Error("No active call to transfer");
    if (this.transferSession) throw new Error("Attended transfer already in progress");

    if (!this.state.call?.held) {
      await this.setHold(true);
    }

    const targetUri = this.makeTargetUri(target);
    const inviter = new Inviter(this.userAgent, targetUri);
    this.transferSession = inviter;
    this.transferMeta = makeCallMeta("outgoing", target);
    this.setCall({ attendedTransfer: { remoteIdentity: target, state: "connecting" } });
    this.wireTransferSession(inviter, this.transferMeta);

    try {
      await inviter.invite();
    } catch (error) {
      this.transferSession = null;
      this.transferMeta = null;
      this.setCall({ attendedTransfer: null });
      throw error;
    }
  }

  /** Completes an attended transfer: REFERs the original call to the consultation call (RFC 5589 REFER w/Replaces). */
  async completeAttendedTransfer(): Promise<void> {
    const primary = this.session;
    const target = this.transferSession;
    if (!primary || primary.state !== SessionState.Established) throw new Error("No active call to transfer");
    if (!target || target.state !== SessionState.Established) {
      throw new Error("Attended transfer target must answer before completing");
    }
    if (this.transferMeta) this.transferMeta.outcome = "answered";
    await primary.refer(target, {
      onNotify: (notification) => {
        // A 2xx in the REFER-triggered NOTIFY body means the far end
        // successfully re-INVITEd the transfer target with Replaces —
        // both of our legs are now redundant and should be torn down.
        if (/^SIP\/2\.0 2\d\d/.test(notification.request.body ?? "")) {
          void this.hangup();
          void this.cancelAttendedTransfer();
        }
      },
    });
  }

  /** Ends the in-progress consultation call without completing the transfer. */
  async cancelAttendedTransfer(): Promise<void> {
    const session = this.transferSession;
    if (!session) return;
    if (this.transferMeta && !this.transferMeta.answeredAt) {
      this.transferMeta.outcome = "canceled";
    }
    try {
      if (session.state === SessionState.Initial || session.state === SessionState.Establishing) {
        await session.cancel();
      } else if (session.state === SessionState.Established) {
        await session.bye();
      }
    } catch {
      // best-effort — the Terminated state-change listener performs cleanup either way
    }
  }

  private makeTargetUri(target: string) {
    if (!this.userAgent) throw new Error("Not registered");
    const uri = UserAgent.makeURI(
      target.includes("@") ? `sip:${target}` : `sip:${target}@${this.userAgent.configuration.uri.host}`,
    );
    if (!uri) throw new Error(`Invalid call target: ${target}`);
    return uri;
  }

  private applyTrackState(session: Session, held: boolean, muted: boolean): void {
    const sdh = session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    if (!sdh) return;
    sdh.enableReceiverTracks(!held);
    sdh.enableSenderTracks(!held && !muted);
  }

  private handleIncomingCall(invitation: Invitation): void {
    if (this.session) {
      // Already on a call — decline further invites (no call-waiting in M2).
      void invitation.reject();
      const remoteIdentity = invitation.remoteIdentity.uri.toString();
      this.emitHistoryEntry({
        id: crypto.randomUUID(),
        direction: "incoming",
        remoteIdentity,
        startedAt: Date.now(),
        answeredAt: null,
        endedAt: Date.now(),
        outcome: "rejected",
      });
      return;
    }
    this.session = invitation;
    const remoteIdentity = invitation.remoteIdentity.uri.toString();
    this.callMeta = makeCallMeta("incoming", remoteIdentity);
    this.setState({
      call: { direction: "incoming", state: "ringing", remoteIdentity, muted: false, held: false, attendedTransfer: null },
    });
    this.wirePrimarySession(invitation, this.callMeta);
  }

  private wirePrimarySession(session: Inviter | Invitation, meta: CallMeta): void {
    session.stateChange.addListener((newState) => {
      switch (newState) {
        case SessionState.Established:
          meta.answeredAt = Date.now();
          this.attachRemoteMedia(session);
          this.setCall({ state: "established" });
          break;
        case SessionState.Terminated:
          if (this.session === session) {
            this.session = null;
            this.recordHistory(meta);
            this.callMeta = null;
            this.setCall(null);
          }
          break;
        default:
          break;
      }
    });
  }

  private wireTransferSession(session: Inviter, meta: CallMeta): void {
    const snapshot = (callState: AttendedTransferSnapshot["state"]): AttendedTransferSnapshot => ({
      remoteIdentity: meta.remoteIdentity,
      state: callState,
    });
    session.stateChange.addListener((newState) => {
      switch (newState) {
        case SessionState.Established:
          meta.answeredAt = Date.now();
          this.attachRemoteMedia(session);
          this.setCall({ attendedTransfer: snapshot("established") });
          break;
        case SessionState.Terminated:
          if (this.transferSession === session) {
            this.transferSession = null;
            this.recordHistory(meta);
            this.transferMeta = null;
            this.setCall({ attendedTransfer: null });
            // Restore the primary call's audio now that the consultation call is gone.
            if (this.session) this.attachRemoteMedia(this.session);
          }
          break;
        default:
          break;
      }
    });
  }

  private attachRemoteMedia(session: Session): void {
    const sdh = session.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    const peerConnection = sdh?.peerConnection;
    if (!peerConnection) return;

    const remoteStream = new MediaStream();
    for (const receiver of peerConnection.getReceivers()) {
      if (receiver.track) remoteStream.addTrack(receiver.track);
    }
    this.remoteAudio.srcObject = remoteStream;
  }
}

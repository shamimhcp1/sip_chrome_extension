// Wraps SIP.js to register a single account over WSS and handle one call
// at a time (outbound and inbound), with remote audio played through a
// hidden <audio> element that lives in the offscreen document.
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
import type { CallSnapshot, StateSnapshot } from "../lib/sip-state";

type Listener = (state: StateSnapshot) => void;

export class SipClient {
  private userAgent: UserAgent | null = null;
  private registerer: Registerer | null = null;
  private session: Inviter | Invitation | null = null;
  private readonly remoteAudio: HTMLAudioElement;
  private state: StateSnapshot = { registration: "unregistered", call: null };
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.remoteAudio = document.createElement("audio");
    this.remoteAudio.autoplay = true;
    document.body.appendChild(this.remoteAudio);
  }

  getState(): StateSnapshot {
    return this.state;
  }

  onStateChange(listener: Listener): void {
    this.listeners.add(listener);
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

    const targetUri = UserAgent.makeURI(
      target.includes("@") ? `sip:${target}` : `sip:${target}@${this.userAgent.configuration.uri.host}`,
    );
    if (!targetUri) throw new Error(`Invalid call target: ${target}`);

    const inviter = new Inviter(this.userAgent, targetUri);
    this.session = inviter;
    this.setState({ call: { direction: "outgoing", state: "connecting", remoteIdentity: target } });
    this.wireSession(inviter);
    await inviter.invite();
  }

  async answer(): Promise<void> {
    if (!(this.session instanceof Invitation)) return;
    this.setCall({ state: "connecting" });
    await this.session.accept();
  }

  async reject(): Promise<void> {
    if (!(this.session instanceof Invitation)) return;
    await this.session.reject();
    this.session = null;
    this.setCall(null);
  }

  async hangup(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    try {
      if (session instanceof Inviter && session.state === SessionState.Initial) {
        await session.cancel();
      } else if (session.state === SessionState.Established) {
        await session.bye();
      } else if (session instanceof Invitation) {
        await session.reject();
      }
    } catch {
      // best-effort — the session is being torn down either way
    } finally {
      this.setCall(null);
    }
  }

  private handleIncomingCall(invitation: Invitation): void {
    if (this.session) {
      // Already on a call — decline further invites (no call-waiting in M1).
      void invitation.reject();
      return;
    }
    this.session = invitation;
    const remoteIdentity = invitation.remoteIdentity.uri.toString();
    this.setState({ call: { direction: "incoming", state: "ringing", remoteIdentity } });
    this.wireSession(invitation);
  }

  private wireSession(session: Inviter | Invitation): void {
    session.stateChange.addListener((newState) => {
      switch (newState) {
        case SessionState.Established:
          this.attachRemoteMedia(session);
          this.setCall({ state: "established" });
          break;
        case SessionState.Terminated:
          if (this.session === session) this.session = null;
          this.setCall(null);
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

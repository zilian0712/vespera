export type VoiceMode = 'call' | 'ptt';
export type VoicePhase = 'idle' | 'calling' | 'incoming' | 'connecting' | 'active';
export type VoiceOptions = { roomId: string; token: string; clientId: string; friendId?: string | null; connected: boolean };
export type VoiceState = {
  available: boolean;
  enabled: boolean;
  mode: VoiceMode;
  status: 'off' | 'starting' | 'waiting' | 'authenticating' | 'ready';
  phase: VoicePhase;
  authenticated: boolean;
  friendMode: VoiceMode | null;
  muted: boolean;
  holding: boolean;
  talking: boolean;
  listening: boolean;
  error: string;
};

type Listener = (...args: any[]) => void;
export interface VoiceDataConnection {
  peer: string;
  connectionId: string;
  label: string;
  open: boolean;
  peerConnection: RTCPeerConnection;
  on(event: string, listener: Listener): unknown;
  send(data: unknown): void;
  close(): void;
}
export interface VoiceMediaConnection {
  peer: string;
  connectionId: string;
  metadata: unknown;
  peerConnection: RTCPeerConnection;
  on(event: string, listener: Listener): unknown;
  answer(stream?: MediaStream): void;
  close(): void;
}
export interface VoicePeer {
  on(event: string, listener: Listener): unknown;
  connect(id: string, options: { label: string; serialization: 'json'; reliable: boolean }): VoiceDataConnection;
  call(id: string, stream: MediaStream, options: { metadata: unknown }): VoiceMediaConnection;
  destroy(): void;
}
export type VoicePeerOptions = {
  host: string;
  port: number;
  path: string;
  secure: boolean;
  debug: 0;
  config: RTCConfiguration;
};
export type VoiceDependencies = {
  createPeer?: (id: string, options: VoicePeerOptions) => Promise<VoicePeer> | VoicePeer;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  crypto?: Crypto;
  onRemoteStream?: (stream: MediaStream | null) => void;
};

export const VOICE_PEER_OPTIONS: VoicePeerOptions = {
  host: '0.peerjs.com', port: 443, path: '/', secure: true, debug: 0,
  config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
};
const LABEL = 'zhima-voice-v1';
const TIMEOUT = 15000;
const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).map(value => value.toString(16).padStart(2, '0')).join('');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const modeValue = (value: unknown): value is VoiceMode => value === 'call' || value === 'ptt';
const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach(track => { track.enabled = false; track.stop(); });

async function hmac(crypto: Crypto, key: CryptoKey, parts: string[]) {
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(parts))));
}
export async function deriveVoiceIdentity(options: Pick<VoiceOptions, 'roomId' | 'token' | 'clientId' | 'friendId'>, crypto: Crypto = globalThis.crypto) {
  const root = await crypto.subtle.importKey('raw', new TextEncoder().encode(options.token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const material = await hmac(crypto, root, ['zhima', 'voice-key', 'v1', options.roomId]);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(material), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const peerId = `zv-${await hmac(crypto, key, ['peer-id', options.roomId, options.clientId])}`;
  const friendPeerId = options.friendId ? `zv-${await hmac(crypto, key, ['peer-id', options.roomId, options.friendId])}` : '';
  return { key, peerId, friendPeerId };
}

function fingerprint(description: RTCSessionDescription | RTCSessionDescriptionInit | null) {
  const matches = [...(description?.sdp || '').matchAll(/^a=fingerprint:sha-256 ([\dA-Fa-f:]+)\r?$/gm)];
  const values = [...new Set(matches.map(match => match[1].replaceAll(':', '').toLowerCase()))];
  return values.length === 1 && identifier(values[0]) ? values[0] : '';
}
function fingerprints(connection: RTCPeerConnection) {
  return { local: fingerprint(connection.localDescription), remote: fingerprint(connection.remoteDescription) };
}

async function defaultPeer(id: string, options: VoicePeerOptions): Promise<VoicePeer> {
  const { default: Peer } = await import('peerjs');
  return new Peer(id, options) as unknown as VoicePeer;
}

type Auth = {
  connection: VoiceDataConnection;
  nonce: string;
  remoteNonce: string;
  sentProof: boolean;
  verified: boolean;
  readyReceived: boolean;
  readySent: boolean;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};
type Session = {
  id: string;
  mode: VoiceMode;
  direction: 'in' | 'out';
  connection?: VoiceMediaConnection;
  local: MediaStream | null;
  remote: MediaStream | null;
  delivered: MediaStream | null;
  mediaProof: { connectionId: string; local: string; remote: string } | null;
  proofSent: boolean;
  bound: boolean;
  timer: ReturnType<typeof setTimeout>;
  poll?: ReturnType<typeof setInterval>;
  dispose?: () => void;
};

export class VoiceController {
  private options: VoiceOptions;
  private dependencies: VoiceDependencies;
  private state: VoiceState;
  private subscribers = new Set<() => void>();
  private generation = 0;
  private captures = new Set<MediaStream>();
  private peer: VoicePeer | null = null;
  private identity: Awaited<ReturnType<typeof deriveVoiceIdentity>> | null = null;
  private auth: Auth | null = null;
  private sessions = new Map<string, Session>();
  private retry?: ReturnType<typeof setTimeout>;
  private startup?: ReturnType<typeof setTimeout>;
  private destroyed = false;

  constructor(options: VoiceOptions, dependencies: VoiceDependencies = {}) {
    this.options = options;
    this.dependencies = dependencies;
    this.state = {
      available: !!options.roomId && !!options.token && !!options.clientId && options.connected,
      enabled: false, mode: 'call', status: 'off', phase: 'idle', authenticated: false,
      friendMode: null, muted: false, holding: false, talking: false, listening: false, error: '',
    };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.subscribers.add(listener); return () => { this.subscribers.delete(listener); }; };
  private patch(values: Partial<VoiceState>) {
    if (this.destroyed) return;
    this.state = { ...this.state, ...values };
    this.subscribers.forEach(listener => listener());
  }
  private random() { return hex((this.dependencies.crypto || globalThis.crypto).getRandomValues(new Uint8Array(32))); }
  update(options: VoiceOptions) {
    const changed = this.options.roomId !== options.roomId || this.options.token !== options.token
      || this.options.clientId !== options.clientId || this.options.friendId !== options.friendId || this.options.connected !== options.connected;
    if (changed) this.shutdown();
    this.options = options;
    this.patch({ available: !!options.roomId && !!options.token && !!options.clientId && options.connected });
  }
  enable = async () => {
    if (this.destroyed || this.state.enabled || !this.state.available) return;
    const crypto = this.dependencies.crypto || globalThis.crypto;
    if (!crypto?.subtle || (!this.dependencies.getUserMedia && !globalThis.navigator?.mediaDevices?.getUserMedia)) {
      this.patch({ error: '当前浏览器不支持安全语音，请使用 HTTPS 和新版浏览器。' }); return;
    }
    const generation = ++this.generation;
    this.patch({ enabled: true, status: 'starting', error: '' });
    try {
      const identity = await deriveVoiceIdentity(this.options, crypto);
      if (generation !== this.generation || !this.state.enabled) return;
      this.identity = identity;
      const peer = await (this.dependencies.createPeer || defaultPeer)(identity.peerId, {
        ...VOICE_PEER_OPTIONS, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
      });
      if (generation !== this.generation || !this.state.enabled) { peer.destroy(); return; }
      this.peer = peer;
      const active = () => generation === this.generation && this.peer === peer;
      this.startup = setTimeout(() => { if (active()) this.fail('语音服务连接超时，请关闭后重试。'); }, TIMEOUT);
      peer.on('open', () => {
        if (!active()) return;
        clearTimeout(this.startup);
        this.patch({ status: 'waiting' });
        this.connect();
      });
      peer.on('connection', (connection: VoiceDataConnection) => {
        if (!active()) { connection.close(); return; }
        this.attachData(connection, false);
      });
      peer.on('call', (connection: VoiceMediaConnection) => {
        if (!active()) { connection.close(); return; }
        this.receiveMedia(connection);
      });
      peer.on('disconnected', () => { if (active()) this.fail('语音连接已断开，请重新开启语音。'); });
      peer.on('close', () => { if (active()) this.fail('语音连接已关闭，请重新开启语音。'); });
      peer.on('error', (error: { type?: string }) => {
        if (!active()) return;
        if (error?.type === 'peer-unavailable') {
          this.dropAuth(); this.scheduleConnect();
        } else this.fail(error?.type === 'unavailable-id' ? '此房间的语音已在另一个页面开启，请先关闭另一页面。' : '语音连接失败，请重新开启或换一个网络。');
      });
    } catch {
      if (generation === this.generation) this.fail('无法开启语音，请检查浏览器和网络后重试。');
    }
  };
  disable = () => { this.shutdown(); };
  destroy = () => { this.shutdown(); this.destroyed = true; this.subscribers.clear(); };
  setMode = (mode: VoiceMode) => {
    if (this.state.mode === mode) return;
    this.shutdown();
    this.patch({ mode, error: '' });
  };
  private fail(message: string) { this.shutdown(); this.patch({ error: message }); }
  private shutdown() {
    ++this.generation;
    clearTimeout(this.retry); clearTimeout(this.startup);
    const peer = this.peer; this.peer = null;
    this.dropAuth();
    this.identity = null;
    peer?.destroy();
    this.patch({ enabled: false, status: 'off', phase: 'idle', authenticated: false, friendMode: null, muted: false, holding: false, talking: false, listening: false });
  }
  private connect() {
    if (!this.peer || !this.identity?.friendPeerId || this.auth || !this.state.enabled
      || this.options.clientId >= (this.options.friendId || '')) return;
    try { this.attachData(this.peer.connect(this.identity.friendPeerId, { label: LABEL, serialization: 'json', reliable: true }), true); }
    catch { this.fail('无法建立语音连接，请重新开启语音。'); }
  }
  private scheduleConnect() {
    clearTimeout(this.retry);
    if (!this.state.enabled) return;
    this.retry = setTimeout(() => this.connect(), 2500);
  }
  private dropAuth() {
    const auth = this.auth; this.auth = null;
    this.endAll(false);
    for (const stream of this.captures) stopStream(stream);
    this.captures.clear();
    auth?.connection.close();
    if (auth) clearTimeout(auth.timer);
    this.patch({ authenticated: false, friendMode: null, status: this.state.enabled ? 'waiting' : 'off', holding: false, talking: false, listening: false, muted: false });
  }
  private attachData(connection: VoiceDataConnection, outgoing: boolean) {
    if (!this.identity || !this.state.enabled || connection.peer !== this.identity.friendPeerId || connection.label !== LABEL
      || !connection.connectionId || connection.connectionId.length > 160 || this.auth
      || outgoing !== (this.options.clientId < (this.options.friendId || ''))) {
      connection.close(); return;
    }
    const auth: Auth = {
      connection, nonce: this.random(), remoteNonce: '', sentProof: false, verified: false, readyReceived: false, readySent: false,
      queue: Promise.resolve(), timer: setTimeout(() => { if (this.auth === auth) this.rejectAuth(); }, TIMEOUT),
    };
    this.auth = auth;
    this.patch({ status: 'authenticating', error: '' });
    const opened = () => { if (this.auth === auth) this.sendRaw({ v: 1, type: 'challenge', nonce: auth.nonce }); };
    connection.on('open', opened);
    connection.on('data', (data: unknown) => {
      auth.queue = auth.queue.then(async () => {
        if (this.auth === auth) await this.receiveData(auth, data);
      }).catch(() => { if (this.auth === auth) this.rejectAuth(); });
    });
    const closed = () => {
      if (this.auth !== auth) return;
      if (this.state.authenticated || this.sessions.size) this.fail('语音连接已断开，请重新开启语音。');
      else { this.dropAuth(); this.scheduleConnect(); }
    };
    connection.on('close', closed);
    connection.on('error', closed);
    connection.on('iceStateChanged', (state: string) => {
      if (this.auth === auth && ['failed', 'disconnected', 'closed'].includes(state)) this.fail('语音连接已断开，请重新开启语音。');
    });
    if (connection.open) opened();
  }
  private rejectAuth() {
    this.dropAuth();
    this.patch({ error: '对方的语音身份验证失败，请双方重新开启语音。' });
    this.scheduleConnect();
  }
  private sendRaw(data: unknown) {
    const connection = this.auth?.connection;
    if (!connection?.open) return false;
    try { connection.send(data); return true; }
    catch { this.dropAuth(); this.patch({ error: '语音连接已断开，请重新开启语音。' }); return false; }
  }
  private send(type: string, values: Record<string, unknown> = {}) {
    return this.state.authenticated && this.sendRaw({ v: 1, type, ...values });
  }
  private proofParts(auth: Auth, sender: string, receiver: string, nonce: string, remoteNonce: string, local: string, remote: string) {
    return ['zhima-voice-auth', 'v1', auth.connection.connectionId, sender, receiver, nonce, remoteNonce, local, remote];
  }
  private async receiveData(auth: Auth, data: unknown) {
    if (!record(data) || data.v !== 1 || typeof data.type !== 'string') { this.rejectAuth(); return; }
    const identity = this.identity!;
    const crypto = this.dependencies.crypto || globalThis.crypto;
    const prints = fingerprints(auth.connection.peerConnection);
    if (data.type === 'challenge') {
      if (!identifier(data.nonce) || auth.remoteNonce || !prints.local || !prints.remote) { this.rejectAuth(); return; }
      auth.remoteNonce = data.nonce;
      const proof = await hmac(crypto, identity.key, this.proofParts(auth, identity.peerId, identity.friendPeerId, auth.nonce, auth.remoteNonce, prints.local, prints.remote));
      if (this.auth !== auth) return;
      auth.sentProof = true;
      this.sendRaw({ v: 1, type: 'proof', proof });
      return;
    }
    if (data.type === 'proof') {
      if (auth.verified || !auth.remoteNonce || !identifier(data.proof) || !prints.local || !prints.remote) { this.rejectAuth(); return; }
      const bytes = new Uint8Array(data.proof.match(/../g)!.map(pair => parseInt(pair, 16)));
      const valid = await crypto.subtle.verify('HMAC', identity.key, bytes, new TextEncoder().encode(JSON.stringify(
        this.proofParts(auth, identity.friendPeerId, identity.peerId, auth.remoteNonce, auth.nonce, prints.remote, prints.local),
      )));
      if (this.auth !== auth) return;
      if (!valid || !auth.sentProof) { this.rejectAuth(); return; }
      auth.verified = true;
      auth.readySent = this.sendRaw({ v: 1, type: 'ready', mode: this.state.mode });
      this.finishAuth(auth);
      return;
    }
    if (data.type === 'ready') {
      if (!auth.verified || !modeValue(data.mode) || auth.readyReceived) { this.rejectAuth(); return; }
      auth.readyReceived = true;
      this.patch({ friendMode: data.mode });
      this.finishAuth(auth);
      return;
    }
    if (!this.state.authenticated || !auth.verified || !auth.readyReceived) { this.rejectAuth(); return; }
    if (!identifier(data.sessionId)) { this.rejectAuth(); return; }
    const id = data.sessionId;
    if (data.type === 'offer') {
      if (!modeValue(data.mode)) { this.rejectAuth(); return; }
      if (data.mode !== this.state.mode || this.state.friendMode !== data.mode) { this.send('reject', { sessionId: id }); return; }
      if (this.sessions.has(id)) { this.rejectAuth(); return; }
      const normal = [...this.sessions.values()].find(session => session.mode === 'call');
      if (normal) {
        if (normal.direction === 'out' && this.options.clientId > (this.options.friendId || '')) this.endSession(normal, false);
        else { this.send('reject', { sessionId: id }); return; }
      }
      if (data.mode === 'ptt' && [...this.sessions.values()].some(session => session.mode === 'ptt' && session.direction === 'in')) {
        this.send('reject', { sessionId: id }); return;
      }
      const session = this.createSession(id, data.mode, 'in');
      if (data.mode === 'call') this.patch({ phase: 'incoming', error: '' });
      else this.send('accept', { sessionId: session.id });
      return;
    }
    const session = this.sessions.get(id);
    if (!session) return;
    if (data.type === 'accept') {
      if (session.direction !== 'out' || session.connection) { this.rejectAuth(); return; }
      this.beginMedia(session);
    } else if (data.type === 'reject' || data.type === 'end') {
      const declined = data.type === 'reject' && session.mode === 'call';
      this.endSession(session, false);
      if (declined) this.patch({ error: '对方暂时不方便接听。' });
    } else if (data.type === 'media-proof') {
      if (typeof data.connectionId !== 'string' || !data.connectionId || data.connectionId.length > 160
        || !identifier(data.local) || !identifier(data.remote) || session.mediaProof) { this.rejectAuth(); return; }
      session.mediaProof = { connectionId: data.connectionId, local: data.local, remote: data.remote };
      this.bindMedia(session);
    } else this.rejectAuth();
  }
  private finishAuth(auth: Auth) {
    if (this.auth !== auth || !auth.verified || !auth.readySent || !auth.readyReceived) return;
    clearTimeout(auth.timer);
    this.patch({ authenticated: true, status: 'ready', error: '' });
  }
  private createSession(id: string, mode: VoiceMode, direction: 'in' | 'out') {
    const session: Session = {
      id, mode, direction, local: null, remote: null, delivered: null, mediaProof: null, proofSent: false, bound: false,
      timer: setTimeout(() => {
        if (!this.sessions.has(id)) return;
        this.endSession(session, true);
        this.patch({ error: '语音连接超时。当前网络可能无法直连，请换一个网络再试。' });
      }, mode === 'call' ? 45000 : TIMEOUT),
    };
    this.sessions.set(id, session);
    return session;
  }
  private canCall(mode: VoiceMode) {
    if (!this.state.enabled || !this.state.authenticated || this.state.mode !== mode) return false;
    if (this.state.friendMode !== mode) {
      this.patch({ error: mode === 'call' ? '请让朋友也切换到连麦并开启语音。' : '请让朋友也切换到对讲并开启语音。' }); return false;
    }
    return true;
  }
  call = () => {
    if (!this.canCall('call') || this.sessions.size) return;
    const session = this.createSession(this.random(), 'call', 'out');
    this.patch({ phase: 'calling', muted: false, error: '' });
    void this.capture(session, false).then(stream => {
      if (!stream || !this.sessions.has(session.id)) return;
      this.send('offer', { sessionId: session.id, mode: 'call' });
    });
  };
  accept = () => {
    const session = [...this.sessions.values()].find(value => value.mode === 'call' && value.direction === 'in');
    if (!session || this.state.phase !== 'incoming') return;
    this.patch({ phase: 'connecting', muted: false, error: '' });
    void this.capture(session, false).then(stream => {
      if (stream && this.sessions.has(session.id)) this.send('accept', { sessionId: session.id });
    });
  };
  reject = () => {
    const session = [...this.sessions.values()].find(value => value.mode === 'call' && value.direction === 'in');
    if (session) { this.send('reject', { sessionId: session.id }); this.endSession(session, false); }
  };
  hangUp = () => { this.endAll(true); this.patch({ error: '' }); };
  toggleMute = () => {
    if (this.state.mode !== 'call') return;
    this.patch({ muted: !this.state.muted });
    for (const session of this.sessions.values()) this.applyTracks(session);
  };
  startTalking = () => {
    if (!this.canCall('ptt') || this.state.holding) return;
    const session = this.createSession(this.random(), 'ptt', 'out');
    this.patch({ holding: true, talking: false, error: '' });
    void this.capture(session, true).then(stream => {
      if (!stream || !this.state.holding || !this.sessions.has(session.id)) return;
      this.send('offer', { sessionId: session.id, mode: 'ptt' });
    });
  };
  stopTalking = () => {
    this.patch({ holding: false, talking: false });
    for (const session of [...this.sessions.values()]) {
      if (session.mode === 'ptt' && session.direction === 'out') this.endSession(session, true);
    }
  };
  suspend = () => {
    this.stopTalking();
    if (this.state.mode === 'call' && this.state.phase !== 'idle') {
      this.patch({ muted: true });
      for (const session of this.sessions.values()) this.applyTracks(session);
    }
  };
  private async capture(session: Session, hold: boolean) {
    const generation = this.generation;
    try {
      const getUserMedia = this.dependencies.getUserMedia || ((constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints));
      const stream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      stream.getTracks().forEach(track => { track.enabled = false; });
      if (generation !== this.generation || !this.state.enabled
        || this.sessions.get(session.id) !== session || (hold && !this.state.holding)) {
        stopStream(stream); return null;
      }
      if (!stream.getAudioTracks().length || stream.getTracks().some(track => track.kind !== 'audio')) {
        stopStream(stream); throw new Error('invalid-stream');
      }
      session.local = stream;
      this.captures.add(stream);
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => {
        if (this.sessions.get(session.id) === session) {
          this.endSession(session, true);
          this.patch({ error: '麦克风已断开，请重新呼叫或按住说话。' });
        }
      }, { once: true }));
      this.applyTracks(session);
      return stream;
    } catch {
      if (generation === this.generation && this.sessions.get(session.id) === session) {
        this.send('reject', { sessionId: session.id });
        this.endSession(session, true);
        this.patch({ error: '无法使用麦克风，请在浏览器中允许麦克风权限后重试。' });
      }
      return null;
    }
  }
  private beginMedia(session: Session) {
    if (!this.peer || !this.identity || !session.local || !this.state.authenticated || !this.sessions.has(session.id)) return;
    if (session.mode === 'ptt' && !this.state.holding) { this.endSession(session, true); return; }
    try {
      const connection = this.peer.call(this.identity.friendPeerId, session.local, { metadata: { v: 1, sessionId: session.id, mode: session.mode } });
      this.attachMedia(session, connection);
      if (session.mode === 'call') this.patch({ phase: 'connecting' });
    } catch { this.endSession(session, true); this.patch({ error: '无法建立语音直连，请换一个网络再试。' }); }
  }
  private receiveMedia(connection: VoiceMediaConnection) {
    const metadata = connection.metadata;
    if (!this.state.enabled || !this.state.authenticated || connection.peer !== this.identity?.friendPeerId || !record(metadata)
      || metadata.v !== 1 || !identifier(metadata.sessionId) || !modeValue(metadata.mode)) { connection.close(); return; }
    const session = this.sessions.get(metadata.sessionId);
    if (!session || session.direction !== 'in' || session.mode !== metadata.mode || session.connection
      || (session.mode === 'call' && !session.local)) { connection.close(); return; }
    session.connection = connection;
    try {
      connection.answer(session.mode === 'ptt' ? undefined : session.local!);
      this.attachMedia(session, connection);
    } catch { this.endSession(session, true); this.patch({ error: '无法接听语音，请重新呼叫。' }); }
  }
  private attachMedia(session: Session, connection: VoiceMediaConnection) {
    session.connection = connection;
    connection.on('stream', (stream: MediaStream) => {
      if (this.sessions.get(session.id) !== session) { stopStream(stream); return; }
      if (session.remote === stream) return;
      stream.getTracks().forEach(track => { track.enabled = false; });
      if (session.mode === 'ptt' && session.direction === 'out') { stopStream(stream); return; }
      if (!stream.getAudioTracks().length || stream.getTracks().some(track => track.kind !== 'audio')) {
        stopStream(stream); this.endSession(session, true); return;
      }
      if (session.remote && session.remote !== stream) stopStream(session.remote);
      session.remote = stream;
      this.bindMedia(session);
    });
    connection.on('close', () => { if (this.sessions.get(session.id) === session) this.endSession(session, false); });
    connection.on('error', () => {
      if (this.sessions.get(session.id) !== session) return;
      this.fail('语音直连失败。当前网络可能无法直连，请换一个网络。');
    });
    const pc = connection.peerConnection;
    const changed = () => {
      if (this.sessions.get(session.id) !== session) return;
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) || ['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        this.fail('语音直连已断开，请重新开启语音。');
      } else this.bindMedia(session);
    };
    pc.addEventListener('connectionstatechange', changed);
    pc.addEventListener('iceconnectionstatechange', changed);
    pc.addEventListener('signalingstatechange', changed);
    session.dispose = () => {
      pc.removeEventListener('connectionstatechange', changed);
      pc.removeEventListener('iceconnectionstatechange', changed);
      pc.removeEventListener('signalingstatechange', changed);
    };
    session.poll = setInterval(() => this.bindMedia(session), 100);
    this.bindMedia(session);
  }
  private bindMedia(session: Session) {
    if (this.sessions.get(session.id) !== session || !this.state.authenticated || !session.connection) return;
    const prints = fingerprints(session.connection.peerConnection);
    if (!prints.local || !prints.remote) return;
    if (!session.proofSent) {
      session.proofSent = true;
      if (!this.send('media-proof', { sessionId: session.id, connectionId: session.connection.connectionId, ...prints })) return;
    }
    const proof = session.mediaProof;
    if (!proof) return;
    if (proof.connectionId !== session.connection.connectionId || proof.local !== prints.remote || proof.remote !== prints.local) {
      this.endSession(session, true);
      this.patch({ error: '语音通道验证失败，请双方重新开启语音。' }); return;
    }
    if (!session.bound) {
      session.bound = true;
      clearTimeout(session.timer); clearInterval(session.poll);
      if (session.mode === 'call') this.patch({ phase: 'active' });
      this.applyTracks(session);
    }
    if (session.remote && session.delivered !== session.remote) {
      session.remote.getAudioTracks().forEach(track => { track.enabled = true; });
      session.delivered = session.remote;
      this.dependencies.onRemoteStream?.(session.remote);
      this.patch({ listening: true });
    }
  }
  private applyTracks(session: Session) {
    const enabled = session.bound && this.state.enabled && this.state.authenticated
      && (session.mode === 'ptt' ? this.state.holding && session.direction === 'out' : !this.state.muted);
    session.local?.getAudioTracks().forEach(track => { track.enabled = enabled; });
    if (session.mode === 'ptt' && session.direction === 'out') this.patch({ talking: enabled });
  }
  private endSession(session: Session, notify: boolean) {
    if (this.sessions.get(session.id) !== session) return;
    this.sessions.delete(session.id);
    clearTimeout(session.timer); clearInterval(session.poll);
    session.dispose?.();
    stopStream(session.local); stopStream(session.remote);
    if (notify) this.send('end', { sessionId: session.id });
    if (session.local) this.captures.delete(session.local);
    session.connection?.close();
    if (session.delivered) this.dependencies.onRemoteStream?.(null);
    const listening = [...this.sessions.values()].some(value => value.bound && !!value.remote);
    const values: Partial<VoiceState> = { listening };
    if (session.mode === 'call') { values.phase = 'idle'; values.muted = false; }
    if (session.mode === 'ptt' && session.direction === 'out') { values.holding = false; values.talking = false; }
    this.patch(values);
  }
  private endAll(notify: boolean) {
    for (const session of [...this.sessions.values()]) this.endSession(session, notify);
    this.dependencies.onRemoteStream?.(null);
    this.patch({ phase: 'idle', holding: false, talking: false, listening: false, muted: false });
  }
}

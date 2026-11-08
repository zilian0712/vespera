import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import {
  VoiceController, deriveVoiceIdentity, VOICE_PEER_OPTIONS,
  type VoiceOptions, type VoiceMode, type VoicePeer, type VoicePeerOptions, type VoiceDataConnection, type VoiceMediaConnection,
} from '../src/voice.ts';

const crypto = webcrypto as unknown as Crypto;
const token = 'test-room-secret-that-must-never-appear-in-signalling';
const options = (clientId: string, friendId?: string): VoiceOptions => ({ roomId: 'room-test', token, clientId, friendId, connected: true });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(predicate(), 'asynchronous voice state did not settle');
}

class Events {
  handlers = new Map<string, ((...args: any[]) => void)[]>();
  on(event: string, callback: (...args: any[]) => void) { this.handlers.set(event, [...this.handlers.get(event) || [], callback]); return this; }
  emit(event: string, ...args: any[]) { this.handlers.get(event)?.forEach(callback => callback(...args)); }
}
class Track extends EventTarget {
  kind = 'audio';
  enabled = true;
  stopped = false;
  stop() { this.enabled = false; this.stopped = true; }
}
class Stream {
  track = new Track();
  getTracks() { return [this.track]; }
  getAudioTracks() { return [this.track]; }
  asMedia() { return this as unknown as MediaStream; }
}
const sdp = (value: string) => ({ type: 'offer', sdp: `v=0\r\na=fingerprint:sha-256 ${value.match(/../g)!.join(':')}\r\n` } as RTCSessionDescription);
function pc(local = 'a'.repeat(64), remote = 'b'.repeat(64)) {
  return Object.assign(new EventTarget(), { localDescription: sdp(local), remoteDescription: sdp(remote), connectionState: 'connected', iceConnectionState: 'connected' }) as unknown as RTCPeerConnection;
}
class Data extends Events implements VoiceDataConnection {
  open = true;
  label = 'zhima-voice-v1';
  peerConnection: RTCPeerConnection;
  other?: Data;
  closed = false;
  constructor(public peer: string, public connectionId: string, public network: Network, public side: 'a' | 'b') {
    super(); this.peerConnection = side === 'a' ? pc() : pc('b'.repeat(64), 'a'.repeat(64));
  }
  send(value: unknown) {
    if (this.closed) throw new Error('closed');
    const data = this.network.transform?.(value, this.side) ?? value;
    this.network.messages.push(data);
    queueMicrotask(() => { if (!this.closed && !this.other?.closed) this.other?.emit('data', data); });
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.open = false; this.emit('close');
    this.other?.close();
  }
}
class Media extends Events implements VoiceMediaConnection {
  peerConnection: RTCPeerConnection;
  other?: Media;
  closed = false;
  answers: (MediaStream | undefined)[] = [];
  stream?: MediaStream;
  constructor(public peer: string, public connectionId: string, public metadata: unknown, side: 'a' | 'b', public network: Network) {
    super(); this.peerConnection = side === 'a' ? pc('c'.repeat(64), 'd'.repeat(64)) : pc('d'.repeat(64), 'c'.repeat(64));
  }
  answer(stream?: MediaStream) {
    this.answers.push(stream); this.stream = stream;
    queueMicrotask(() => {
      if (this.closed) return;
      const incoming = new Stream();
      this.network.remoteStreams.push(incoming);
      this.emit('stream', incoming.asMedia());
      if (stream) {
        const returning = new Stream(); this.network.remoteStreams.push(returning);
        this.other?.emit('stream', returning.asMedia());
      }
    });
  }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); this.other?.close(); } }
}
class Peer extends Events implements VoicePeer {
  destroyed = false;
  connections: (Data | Media)[] = [];
  constructor(public id: string, public network: Network) { super(); }
  connect(id: string, configuration: { label: string; serialization: 'json'; reliable: boolean }) {
    const remote = this.network.peers.get(id);
    assert.ok(remote);
    assert.equal(configuration.label, 'zhima-voice-v1');
    const connectionId = `dc_${this.network.next++}`;
    const a = new Data(id, connectionId, this.network, 'a');
    const b = new Data(this.id, connectionId, this.network, 'b');
    a.other = b; b.other = a;
    this.connections.push(a); remote.connections.push(b);
    this.network.data.push(a, b);
    queueMicrotask(() => remote.emit('connection', b));
    return a;
  }
  call(id: string, stream: MediaStream, { metadata }: { metadata: unknown }) {
    const remote = this.network.peers.get(id)!;
    const connectionId = `mc_${this.network.next++}`;
    const a = new Media(id, connectionId, metadata, 'a', this.network);
    const b = new Media(this.id, connectionId, metadata, 'b', this.network);
    a.stream = stream; a.other = b; b.other = a;
    this.connections.push(a); remote.connections.push(b);
    this.network.media.push(a, b);
    this.network.messages.push(metadata);
    queueMicrotask(() => remote.emit('call', b));
    return a;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; this.connections.forEach(connection => connection.close());
    this.emit('close');
  }
}
class Network {
  peers = new Map<string, Peer>();
  messages: unknown[] = [];
  data: Data[] = [];
  media: Media[] = [];
  remoteStreams: Stream[] = [];
  settings: VoicePeerOptions[] = [];
  next = 0;
  transform?: (data: unknown, side: 'a' | 'b') => unknown;
  createPeer = (id: string, settings: VoicePeerOptions) => {
    const peer = new Peer(id, this); this.peers.set(id, peer); this.settings.push(settings); return peer;
  };
  open() { this.peers.forEach(peer => peer.emit('open', peer.id)); }
}

async function pair(mode: VoiceMode = 'call', configure?: (network: Network) => void) {
  const network = new Network(); configure?.(network);
  const aStreams: Stream[] = [], bStreams: Stream[] = [];
  const received: { a: (MediaStream | null)[]; b: (MediaStream | null)[] } = { a: [], b: [] };
  const pending: { a?: Promise<MediaStream>; b?: Promise<MediaStream> } = {};
  const a = new VoiceController(options('alice', 'bob'), {
    createPeer: network.createPeer, crypto,
    getUserMedia: () => { const stream = new Stream(); aStreams.push(stream); return pending.a || Promise.resolve(stream.asMedia()); },
    onRemoteStream: stream => received.a.push(stream),
  });
  const b = new VoiceController(options('bob', 'alice'), {
    createPeer: network.createPeer, crypto,
    getUserMedia: () => { const stream = new Stream(); bStreams.push(stream); return pending.b || Promise.resolve(stream.asMedia()); },
    onRemoteStream: stream => received.b.push(stream),
  });
  a.setMode(mode); b.setMode(mode);
  await Promise.all([a.enable(), b.enable()]);
  network.open();
  const close = () => { a.destroy(); b.destroy(); };
  return { network, a, b, aStreams, bStreams, pending, received, close };
}
async function readyPair(mode: VoiceMode = 'call') {
  const result = await pair(mode);
  await until(() => result.a.getSnapshot().authenticated && result.b.getSnapshot().authenticated);
  return result;
}

test('voice identity is room/client bound and signalling uses explicit STUN without the room secret', async () => {
  const first = await deriveVoiceIdentity(options('alice', 'bob'), crypto);
  const again = await deriveVoiceIdentity(options('alice', 'bob'), crypto);
  const other = await deriveVoiceIdentity({ ...options('alice', 'bob'), roomId: 'another-room' }, crypto);
  assert.equal(first.peerId, again.peerId); assert.notEqual(first.peerId, other.peerId);
  const result = await readyPair();
  try {
    assert.equal(result.aStreams.length + result.bStreams.length, 0);
    assert.equal(result.network.data.length, 2, 'only the ordered initiator makes a data connection');
    assert.deepEqual(VOICE_PEER_OPTIONS.config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
    for (const settings of result.network.settings) {
      assert.equal(settings.host, '0.peerjs.com'); assert.equal(settings.port, 443); assert.equal(settings.secure, true);
      assert.deepEqual(settings.config.iceServers, [{ urls: 'stun:stun.l.google.com:19302' }]);
      assert.equal('token' in settings, false);
    }
    assert.equal(JSON.stringify(result.network.messages).includes(token), false);
  } finally { result.close(); }
});

test('ordinary call never opens the receiver microphone before accepting, then mutes and hangs up both ends', async () => {
  const result = await readyPair();
  const { a, b, aStreams, bStreams, network } = result;
  try {
    a.call();
    assert.equal(aStreams.length, 1, 'capture begins inside the caller gesture');
    await until(() => b.getSnapshot().phase === 'incoming');
    assert.equal(bStreams.length, 0); assert.equal(network.media.length, 0);
    assert.equal(aStreams[0].track.enabled, false, 'track stays disabled while the call is unverified');
    b.accept();
    assert.equal(bStreams.length, 1, 'only the explicit acceptance opens the receiver microphone');
    await until(() => a.getSnapshot().phase === 'active' && b.getSnapshot().phase === 'active');
    assert.equal(aStreams[0].track.enabled, true); assert.equal(bStreams[0].track.enabled, true);
    a.toggleMute(); assert.equal(aStreams[0].track.enabled, false);
    a.toggleMute(); assert.equal(aStreams[0].track.enabled, true);
    b.hangUp();
    await until(() => a.getSnapshot().phase === 'idle');
    assert.equal(aStreams[0].track.stopped, true); assert.equal(bStreams[0].track.stopped, true);
    assert.ok(network.media.every(connection => connection.closed));
  } finally { result.close(); }
});

test('rejecting a call uses no receiver microphone and stops caller capture', async () => {
  const result = await readyPair();
  try {
    result.a.call(); await until(() => result.b.getSnapshot().phase === 'incoming');
    result.b.reject(); await until(() => result.a.getSnapshot().phase === 'idle');
    assert.equal(result.bStreams.length, 0); assert.equal(result.aStreams[0].track.stopped, true);
    assert.equal(result.network.media.length, 0);
    assert.match(result.a.getSnapshot().error, /不方便/);
  } finally { result.close(); }
});

test('PTT automatically answers receive-only after opt-in, and release immediately disables and stops capture', async () => {
  const result = await readyPair('ptt');
  try {
    result.a.startTalking();
    await until(() => result.a.getSnapshot().talking && result.b.getSnapshot().listening);
    assert.equal(result.bStreams.length, 0);
    assert.deepEqual(result.network.media[1].answers, [undefined]);
    assert.equal(result.aStreams[0].track.enabled, true);
    result.a.stopTalking();
    assert.equal(result.aStreams[0].track.enabled, false); assert.equal(result.aStreams[0].track.stopped, true);
    assert.equal(result.a.getSnapshot().talking, false);
    await until(() => !result.b.getSnapshot().listening);
    assert.ok(result.network.media.every(connection => connection.closed));
    result.a.startTalking(); await until(() => result.a.getSnapshot().talking);
    assert.equal(result.aStreams.length, 2, 'a fresh explicit hold can transmit again');
  } finally { result.close(); }
});

test('release before getUserMedia resolves stops the late stream and never sends an offer or audio', async () => {
  const result = await readyPair('ptt');
  try {
    let resolve!: (stream: MediaStream) => void;
    result.pending.a = new Promise(done => { resolve = done; });
    result.a.startTalking(); result.a.stopTalking();
    const late = new Stream(); resolve(late.asMedia()); await tick(); await tick();
    assert.equal(late.track.enabled, false); assert.equal(late.track.stopped, true);
    assert.equal(result.network.media.length, 0);
    assert.equal(result.network.messages.some(value => (value as any)?.type === 'offer'), false);
    assert.equal(result.a.getSnapshot().holding, false);
  } finally { result.close(); }
});

test('an older permission response cannot transmit during a newer hold', async () => {
  const result = await readyPair('ptt');
  try {
    let resolveOld!: (stream: MediaStream) => void;
    result.pending.a = new Promise(done => { resolveOld = done; });
    result.a.startTalking(); result.a.stopTalking();
    delete result.pending.a;
    result.a.startTalking(); await until(() => result.a.getSnapshot().talking);
    const old = new Stream(); resolveOld(old.asMedia()); await tick();
    assert.equal(old.track.stopped, true); assert.equal(old.track.enabled, false);
    assert.equal(result.a.getSnapshot().talking, true);
  } finally { result.close(); }
});

test('closing during the permission prompt stops the late stream and destroys the peer', async () => {
  const result = await readyPair('ptt');
  try {
    let resolve!: (stream: MediaStream) => void;
    result.pending.a = new Promise(done => { resolve = done; });
    result.a.startTalking(); result.a.disable();
    const late = new Stream(); resolve(late.asMedia()); await tick();
    assert.equal(late.track.stopped, true); assert.equal(result.a.getSnapshot().enabled, false);
    assert.equal([...result.network.peers.values()][0].destroyed, true);
    assert.equal(result.network.media.length, 0);
  } finally { result.close(); }
});

test('disconnect, room loss, member departure, mode switch and unmount stop all capture', async () => {
  const cases = [
    (result: Awaited<ReturnType<typeof readyPair>>) => [...result.network.peers.values()][0].emit('disconnected'),
    (result: Awaited<ReturnType<typeof readyPair>>) => result.a.update({ ...options('alice', 'bob'), connected: false }),
    (result: Awaited<ReturnType<typeof readyPair>>) => result.a.update(options('alice')),
    (result: Awaited<ReturnType<typeof readyPair>>) => result.a.setMode('call'),
    (result: Awaited<ReturnType<typeof readyPair>>) => result.a.destroy(),
  ];
  for (const cleanup of cases) {
    const result = await readyPair('ptt');
    try {
      result.a.startTalking(); await until(() => result.a.getSnapshot().talking);
      cleanup(result);
      assert.equal(result.aStreams[0].track.enabled, false); assert.equal(result.aStreams[0].track.stopped, true);
      assert.equal([...result.network.peers.values()][0].destroyed, true);
    } finally { result.close(); }
  }
});

test('window suspension immediately stops PTT and mutes a normal active call', async () => {
  const ptt = await readyPair('ptt');
  try {
    ptt.a.startTalking(); await until(() => ptt.a.getSnapshot().talking);
    ptt.a.suspend(); assert.equal(ptt.aStreams[0].track.stopped, true); assert.equal(ptt.a.getSnapshot().holding, false);
  } finally { ptt.close(); }
  const call = await readyPair();
  try {
    call.a.call(); await until(() => call.b.getSnapshot().phase === 'incoming'); call.b.accept();
    await until(() => call.a.getSnapshot().phase === 'active');
    call.a.suspend(); assert.equal(call.aStreams[0].track.enabled, false); assert.equal(call.a.getSnapshot().muted, true);
  } finally { call.close(); }
});

test('unknown peers, unauthenticated media and malformed messages are rejected', async () => {
  const result = await readyPair();
  try {
    const local = [...result.network.peers.values()][0];
    const unknown = new Media('stranger', 'mc_unknown', { v: 1, sessionId: 'e'.repeat(64), mode: 'ptt' }, 'b', result.network);
    local.emit('call', unknown); assert.equal(unknown.closed, true); assert.equal(result.aStreams.length, 0);
    const extra = new Data('stranger', 'dc_unknown', result.network, 'b');
    local.emit('connection', extra); assert.equal(extra.closed, true);
    result.network.data[0].emit('data', { v: 1, type: 'offer', sessionId: '../not-an-id', mode: 'call' });
    await until(() => !result.a.getSnapshot().authenticated);
    assert.match(result.a.getSnapshot().error, /验证失败/);
  } finally { result.close(); }
});

test('forged HMAC cannot authenticate or trigger capture', async () => {
  const result = await pair('call', network => {
    network.transform = value => (value as any)?.type === 'proof' ? { ...(value as any), proof: '0'.repeat(64) } : value;
  });
  try {
    await until(() => !!result.a.getSnapshot().error || !!result.b.getSnapshot().error);
    assert.equal(result.a.getSnapshot().authenticated, false); assert.equal(result.b.getSnapshot().authenticated, false);
    result.a.call(); result.b.startTalking();
    assert.equal(result.aStreams.length + result.bStreams.length, 0);
    assert.equal(result.network.media.length, 0);
  } finally { result.close(); }
});

test('data proof is bound to actual DTLS fingerprints, preventing proof relay onto another connection', async () => {
  const result = await pair();
  try {
    Object.defineProperty(result.network.data[1].peerConnection, 'remoteDescription', { value: sdp('e'.repeat(64)) });
    await until(() => !!result.a.getSnapshot().error || !!result.b.getSnapshot().error);
    assert.equal(result.a.getSnapshot().authenticated, false); assert.equal(result.b.getSnapshot().authenticated, false);
    assert.equal(result.aStreams.length + result.bStreams.length, 0);
  } finally { result.close(); }
});

test('media fingerprint substitution never enables capture or the remote audio sink', async () => {
  const result = await readyPair();
  try {
    result.network.transform = value => (value as any)?.type === 'media-proof' ? { ...(value as any), local: 'e'.repeat(64) } : value;
    result.a.call(); await until(() => result.b.getSnapshot().phase === 'incoming'); result.b.accept();
    await until(() => !!result.a.getSnapshot().error || !!result.b.getSnapshot().error);
    assert.equal(result.aStreams[0].track.enabled, false); assert.equal(result.bStreams[0].track.enabled, false);
    assert.equal(result.received.a.filter(Boolean).length + result.received.b.filter(Boolean).length, 0);
  } finally { result.close(); }
});

test('authenticated data disconnect destroys the peer and stops an active microphone', async () => {
  const result = await readyPair('ptt');
  try {
    result.a.startTalking(); await until(() => result.a.getSnapshot().talking);
    result.network.data[0].close();
    assert.equal(result.aStreams[0].track.stopped, true);
    assert.equal(result.a.getSnapshot().enabled, false);
    assert.ok([...result.network.peers.values()].every(peer => peer.destroyed));
  } finally { result.close(); }
});

test('data ICE disconnect and media errors shut down instead of leaving an idle authenticated peer', async () => {
  const data = await readyPair('ptt');
  try {
    data.a.startTalking(); await until(() => data.a.getSnapshot().talking);
    data.network.data[0].emit('iceStateChanged', 'disconnected');
    assert.equal(data.aStreams[0].track.stopped, true);
    assert.equal(data.a.getSnapshot().enabled, false);
    assert.equal([...data.network.peers.values()][0].destroyed, true);
  } finally { data.close(); }
  const media = await readyPair('ptt');
  try {
    media.a.startTalking(); await until(() => media.a.getSnapshot().talking);
    media.network.media[0].emit('error', new Error('connection failed'));
    assert.equal(media.aStreams[0].track.stopped, true);
    assert.equal(media.a.getSnapshot().enabled, false);
    assert.equal([...media.network.peers.values()][0].destroyed, true);
  } finally { media.close(); }
});

test('media ICE disconnect destroys the peer and stops all microphone tracks', async () => {
  const result = await readyPair('ptt');
  try {
    result.a.startTalking(); await until(() => result.a.getSnapshot().talking);
    const connection = result.network.media[0].peerConnection;
    Object.defineProperty(connection, 'iceConnectionState', { value: 'disconnected' });
    connection.dispatchEvent(new Event('iceconnectionstatechange'));
    assert.equal(result.aStreams[0].track.stopped, true);
    assert.equal(result.a.getSnapshot().enabled, false);
    assert.equal([...result.network.peers.values()][0].destroyed, true);
  } finally { result.close(); }
});

test('connection state changes never restart the same remote audio stream', async () => {
  const result = await readyPair();
  try {
    result.a.call(); await until(() => result.b.getSnapshot().phase === 'incoming'); result.b.accept();
    await until(() => result.a.getSnapshot().listening && result.b.getSnapshot().listening);
    const before = result.received.a.filter(Boolean).length + result.received.b.filter(Boolean).length;
    result.network.media.forEach(connection => connection.peerConnection.dispatchEvent(new Event('connectionstatechange')));
    assert.equal(result.received.a.filter(Boolean).length + result.received.b.filter(Boolean).length, before);
    const stream = result.received.b.find(Boolean)!;
    result.network.media[1].emit('stream', stream);
    assert.equal(stream.getAudioTracks()[0].enabled, true);
  } finally { result.close(); }
});

test('simultaneous normal calls resolve deterministically to one session', async () => {
  const result = await readyPair();
  try {
    result.a.call(); result.b.call();
    await until(() => result.b.getSnapshot().phase === 'incoming');
    result.b.accept();
    await until(() => result.a.getSnapshot().phase === 'active' && result.b.getSnapshot().phase === 'active');
    assert.equal(result.network.media.length, 2);
    assert.equal(result.bStreams[0].track.stopped, true);
  } finally { result.close(); }
});

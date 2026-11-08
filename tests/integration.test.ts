import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// PRoot cannot run workerd; the mock exercises routing and handlers rather than the Workers runtime.
const workerModule = build({
  entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{
    name: 'durable-object-test',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }',
      }));
    },
  }],
}).then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

async function roomHarness(legacy = false) {
  const { Room } = await workerModule;
  const NativeResponse = globalThis.Response;
  const originalPair = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  let writes = 0;
  class MockSocket {
    readyState = 1;
    attachment: any;
    messages: any[] = [];
    closes: { code: number; reason: string }[] = [];
    serializeAttachment(value: any) { this.attachment = structuredClone(value); }
    deserializeAttachment() { return structuredClone(this.attachment); }
    send(raw: string) { this.messages.push(JSON.parse(raw)); }
    close(code: number, reason: string) { this.readyState = 3; this.closes.push({ code, reason }); }
  }
  const sockets: MockSocket[] = [];
  const values = new Map();
  let initialization: Promise<void> | undefined;
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: any) => { writes++; values.set(key, structuredClone(value)); },
    setAlarm: async () => {},
    deleteAll: async () => { values.clear(); },
    transaction: async (work: any) => work(storage),
  };
  const ctx = {
    storage,
    blockConcurrencyWhile(work: () => Promise<void>) { initialization = work(); },
    getWebSockets: () => sockets,
    acceptWebSocket(socket: MockSocket) { sockets.push(socket); },
  };
  Object.assign(globalThis, { WebSocketPair: class { 0 = new MockSocket(); 1 = new MockSocket(); } });
  globalThis.Response = class extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: MockSocket }) {
      if (init?.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        Object.assign(this, { webSocket: init.webSocket });
      } else super(body, init);
    }
  };
  Date.now = () => now;
  const restore = () => {
    globalThis.Response = NativeResponse;
    Date.now = originalNow;
    if (originalPair) Object.defineProperty(globalThis, 'WebSocketPair', originalPair);
    else delete (globalThis as any).WebSocketPair;
  };
  try {
    const room = new Room(ctx, {});
    await initialization;
    if (legacy) {
      values.set('room', {
        roomId: 'a'.repeat(32), token: 'test-invite', expiresAt: now + 86400000,
        media: { url: 'https://media.test/movie.mp4', kind: 'video', title: 'Legacy' },
        playback: { paused: true, position: 0, rate: 1, updatedAt: now, revision: 0 },
        userPaused: true, waitTogether: false, chat: [],
      });
    }
    const activeRoom = legacy ? new Room(ctx, {}) : room;
    await initialization;
    if (!legacy) {
      const created = await room.fetch(new Request('https://watch.test/internal/create', {
        method: 'POST', body: JSON.stringify({ roomId: 'a'.repeat(32), token: 'test-invite' }),
      }));
      assert.equal(created.status, 201);
    }
    return {
      room: activeRoom, sockets, values, restore,
      now: () => now,
      writes: () => writes,
      advance: (elapsed: number) => { now += elapsed; },
      join: (id: string, token = 'test-invite', origin = 'https://watch.test') => activeRoom.fetch(new Request(
        `https://watch.test/api/rooms/${'a'.repeat(32)}/ws?${new URLSearchParams({ token, clientId: id, name: id })}`,
        { headers: { Upgrade: 'websocket', Origin: origin } },
      )),
      message: (socket: MockSocket, data: object) => activeRoom.webSocketMessage(socket, JSON.stringify(data)),
    };
  } catch (error) { restore(); throw error; }
}

test('Room handlers: two peers, controls, chat, capacity, authentication, reconnect and buffering', async () => {
  const harness = await roomHarness();
  const { room, sockets, join, message } = harness;
  try {
    assert.equal((await join('invalid', 'wrong')).status, 403);
    assert.equal((await join('invalid', 'test-invite', 'https://other.test')).status, 403);
    assert.equal((await join('invalid id')).status, 400);
    assert.equal((await join('first')).status, 101);
    assert.equal((await join('second')).status, 101);
    assert.equal((await join('third')).status, 409);
    const [first, second] = sockets;
    await message(first, { type: 'media', url: 'https://media.test/movie.m3u8', kind: 'video', title: 'Movie' });
    await message(first, { type: 'status', ready: true, buffering: false });
    await message(second, { type: 'status', ready: true, buffering: false });
    await message(first, { type: 'settings', waitTogether: true });
    await message(first, { type: 'control', action: 'play', position: 999 });
    assert.equal(second.messages.at(-1).playback.paused, false);
    assert.equal(second.messages.at(-1).playback.position, 0);
    assert.equal(second.messages.at(-1).userPaused, false);
    await message(first, { type: 'control', action: 'seek', position: 120.123 });
    assert.equal(second.messages.at(-1).playback.position, 120.123);
    await message(second, { type: 'chat', text: '一起看' });
    assert.equal(first.messages.at(-1).message.text, '一起看');
    await message(second, { type: 'status', ready: false, buffering: true });
    assert.equal(first.messages.at(-1).playback.paused, true);
    assert.equal(first.messages.at(-1).userPaused, false);
    await message(first, { type: 'control', action: 'pause', position: 999 });
    assert.equal(second.messages.at(-1).playback.position, 120.123);
    assert.equal(second.messages.at(-1).userPaused, true);
    await message(second, { type: 'status', ready: true, buffering: false });
    await message(first, { type: 'sync' });
    assert.equal(first.messages.at(-1).playback.paused, true);
    await message(first, { type: 'control', action: 'play' });
    assert.equal(first.messages.at(-1).playback.paused, false);
    assert.equal((await join('second')).status, 101);
    assert.equal(second.readyState, 3);
    assert.equal(second.closes[0].code, 4000);
    const replacement = sockets[2];
    assert.equal(first.messages.at(-1).playback.paused, true);
    const count = first.messages.length;
    await message(second, { type: 'control', action: 'seek', position: 999 });
    assert.equal(first.messages.length, count);
    await message(replacement, { type: 'status', ready: true, buffering: false });
    assert.equal(first.messages.at(-1).playback.paused, false);
    await room.webSocketClose(second);
    assert.equal(first.messages.at(-1).members.length, 2);
    assert.equal(first.messages.at(-1).playback.paused, false);
    await message(first, { type: 'control', action: 'pause' });
    await message(replacement, { type: 'sync' });
    assert.equal(replacement.messages.at(-1).type, 'snapshot');
    assert.equal(replacement.messages.at(-1).chat.length, 1);
    assert.equal(replacement.messages.at(-1).playback.paused, true);
  } finally { harness.restore(); }
});

test('Room handlers persist and broadcast seek markers independently of control and waitTogether revisions', async () => {
  const harness = await roomHarness();
  const { join, message, sockets, values } = harness;
  try {
    assert.equal(values.get('room').playback.seekRevision, 0);
    await join('first');
    await join('second');
    const [first, second] = sockets;
    assert.equal(first.messages[0].playback.seekRevision, 0);
    await message(first, { type: 'media', url: 'https://media.test/movie.mp4', kind: 'video', title: 'Movie' });
    await message(first, { type: 'status', ready: true, buffering: false });
    await message(second, { type: 'status', ready: true, buffering: false });
    for (const step of [
      { sender: first, data: { type: 'settings', waitTogether: true }, paused: true, seekRevision: 0 },
      { sender: first, data: { type: 'control', action: 'play' }, paused: false, seekRevision: 0 },
      { sender: first, data: { type: 'control', action: 'rate', rate: 2 }, paused: false, seekRevision: 0 },
      { sender: first, data: { type: 'control', action: 'seek', position: 120.123 }, paused: false, seekRevision: 1 },
      { sender: second, data: { type: 'status', ready: false, buffering: true }, paused: true, seekRevision: 1 },
      { sender: second, data: { type: 'status', ready: true, buffering: false }, paused: false, seekRevision: 1 },
      { sender: first, data: { type: 'control', action: 'pause' }, paused: true, seekRevision: 1 },
      { sender: first, data: { type: 'control', action: 'play' }, paused: false, seekRevision: 1 },
      { sender: first, data: { type: 'control', action: 'rate', rate: 0.5 }, paused: false, seekRevision: 1 },
      { sender: first, data: { type: 'control', action: 'seek', position: 120.123 }, paused: false, seekRevision: 2 },
      { sender: first, data: { type: 'settings', waitTogether: false }, paused: false, seekRevision: 2 },
    ]) {
      const revision = values.get('room').playback.revision;
      await message(step.sender, step.data);
      const broadcast = second.messages.at(-1);
      assert.equal(broadcast.type, 'state');
      assert.equal(broadcast.playback.revision, revision + 1);
      assert.equal(broadcast.playback.seekRevision, step.seekRevision);
      assert.equal(broadcast.playback.paused, step.paused);
      if (step.seekRevision > 0) assert.equal(broadcast.playback.position, 120.123);
      assert.deepEqual(first.messages.at(-1), broadcast);
      assert.deepEqual(values.get('room').playback, broadcast.playback);
    }
    await message(second, { type: 'sync' });
    assert.equal(second.messages.at(-1).type, 'snapshot');
    assert.equal(second.messages.at(-1).playback.seekRevision, 2);
  } finally { harness.restore(); }
});

test('legacy playback without a seek marker loads without migration and broadcasts explicit seeks', async () => {
  const harness = await roomHarness(true);
  const { join, message, sockets, values } = harness;
  try {
    await join('first');
    await join('second');
    const [first, second] = sockets;
    assert.equal('seekRevision' in first.messages[0].playback, false);
    assert.equal('seekRevision' in second.messages[0].playback, false);
    assert.equal(harness.writes(), 0);
    for (const data of [
      { type: 'control', action: 'play' },
      { type: 'control', action: 'pause' },
      { type: 'control', action: 'rate', rate: 2 },
    ]) {
      await message(first, data);
      assert.equal('seekRevision' in second.messages.at(-1).playback, false);
      assert.equal('seekRevision' in values.get('room').playback, false);
    }
    for (const seekRevision of [1, 2]) {
      await message(first, { type: 'control', action: 'seek', position: 123.456 });
      const broadcast = second.messages.at(-1);
      assert.equal(broadcast.type, 'state');
      assert.equal(broadcast.playback.position, 123.456);
      assert.equal(broadcast.playback.revision, 3 + seekRevision);
      assert.equal(broadcast.playback.seekRevision, seekRevision);
      assert.deepEqual(first.messages.at(-1), broadcast);
      assert.deepEqual(values.get('room').playback, broadcast.playback);
    }
  } finally { harness.restore(); }
});

test('every media selection creates a new id, including legacy media and identical URLs', async () => {
  const harness = await roomHarness(true);
  const { join, message, sockets, values } = harness;
  try {
    await join('first');
    const socket = sockets[0];
    const selection = { type: 'media', url: 'https://media.test/movie.mp4', kind: 'video', title: 'Movie' };
    assert.equal(socket.messages[0].media.id, undefined);
    assert.equal(socket.messages[0].media.title, 'Legacy');
    assert.equal('seekRevision' in socket.messages[0].playback, false);
    assert.equal(harness.writes(), 0);
    await message(socket, selection);
    const first = socket.messages.at(-1);
    assert.equal(typeof first.media.id, 'string');
    assert.equal(first.playback.seekRevision, 0);
    await message(socket, { type: 'status', ready: true, buffering: false });
    await message(socket, { type: 'control', action: 'seek', position: 12.345 });
    assert.equal(socket.messages.at(-1).playback.seekRevision, 1);
    await message(socket, selection);
    const second = socket.messages.at(-1);
    assert.notEqual(first.media.id, second.media.id);
    assert.equal(first.media.url, second.media.url);
    assert.equal(second.playback.position, 0);
    assert.equal(second.playback.paused, true);
    assert.equal(second.playback.seekRevision, 0);
    assert.equal(second.userPaused, true);
    assert.equal(second.members[0].ready, false);
    assert.ok(second.playback.revision > first.playback.revision);
    assert.equal(values.get('room').media.id, second.media.id);
    assert.equal(values.get('room').playback.seekRevision, 0);
  } finally { harness.restore(); }
});

test('telemetry broadcasts authenticated measurements without persisting or changing authority', async () => {
  const harness = await roomHarness();
  const { join, message, sockets, values } = harness;
  try {
    await join('first');
    await join('second');
    const [first, second] = sockets;
    await message(first, { type: 'media', url: 'https://media.test/movie.mp4', kind: 'video', title: 'Movie' });
    const state = structuredClone(values.get('room'));
    const count = harness.writes();
    const report = {
      type: 'telemetry', position: 10.123, paused: false, rate: 4.2,
      revision: state.playback.revision, measuredAt: harness.now() - 10,
    };
    await message(first, { ...report, clientId: 'second', receivedAt: 1, playback: { position: 999 } });
    assert.deepEqual(second.messages.at(-1), { ...report, clientId: 'first', receivedAt: harness.now() });
    assert.deepEqual(first.messages.at(-1), second.messages.at(-1));
    assert.equal(harness.writes(), count);
    assert.deepEqual(values.get('room'), state);
    await message(second, { type: 'sync' });
    assert.equal(second.messages.at(-1).type, 'snapshot');
    assert.equal(second.messages.at(-1).playback.position, 0);
    assert.equal('telemetry' in second.messages.at(-1), false);
    const messages = second.messages.length;
    await message(first, { ...report, revision: state.playback.revision - 1 });
    assert.equal(second.messages.length, messages);
    await join('first');
    const replacement = sockets[2];
    assert.equal(replacement.messages[0].type, 'snapshot');
    assert.equal('telemetry' in replacement.messages[0], false);
    await message(first, report);
    assert.equal(replacement.messages.some(value => value.type === 'telemetry'), false);
    await message(replacement, report);
    assert.equal(second.messages.at(-1).clientId, 'first');
    assert.equal(second.messages.at(-1).type, 'telemetry');
  } finally { harness.restore(); }
});

test('actual socket handler validates input, message size, and a 60-message telemetry window', async () => {
  const harness = await roomHarness();
  const { room, join, message, sockets } = harness;
  try {
    await join('first');
    await join('second');
    const [first, second] = sockets;
    await message(first, { type: 'media', url: 'https://media.test/movie.mp4', kind: 'video', title: 'Movie' });
    for (const raw of [
      '{', 'null', '[]', '{"type":"telemetry","position":0}',
      '{"type":"telemetry","position":-1,"paused":false,"rate":1,"revision":1,"measuredAt":0}',
      JSON.stringify({ type: 'chat', text: '大'.repeat(11000) }),
    ]) {
      await room.webSocketMessage(first, raw);
      assert.equal(first.messages.at(-1).code, 'INVALID_MESSAGE');
    }
    await room.webSocketMessage(first, new ArrayBuffer(4));
    assert.equal(first.messages.at(-1).code, 'INVALID_MESSAGE');
    assert.equal(first.readyState, 1);
    harness.advance(10000);
    const count = second.messages.length;
    for (let i = 0; i < 60; i++) {
      await message(first, { type: 'telemetry', position: i / 1000, paused: true, rate: 1, revision: 1, measuredAt: harness.now() });
    }
    assert.equal(second.messages.length, count + 60);
    assert.equal(first.readyState, 1);
    await message(first, { type: 'sync' });
    assert.equal(first.messages.at(-1).code, 'RATE_LIMITED');
    assert.equal(first.closes.at(-1)?.code, 1008);
    assert.equal(second.messages.length, count + 60);
  } finally { harness.restore(); }
});

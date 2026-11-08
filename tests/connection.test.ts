import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { consumeRateLimit } from '../worker/state.ts';

async function hookHarness() {
  const state: unknown[] = [];
  const refs: { current: any }[] = [];
  const callbacks: Function[] = [];
  const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  const scheduled: (() => void)[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let callbackIndex = 0;
  let effectIndex = 0;
  let local = 0;
  let nextTimer = 0;
  let props = ['room-a', 'invite', 'Alice'];
  const timers = new Map<number, { due: number; delay: number; repeat: boolean; callback: () => void }>();
  const epoch = 1_800_000_000_000;
  const page = new EventTarget();
  const browser = new EventTarget();
  let visibility = 'visible';
  Object.defineProperty(page, 'visibilityState', { get: () => visibility });

  const hooks = {
    useState(initial: unknown) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], (value: any) => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial: unknown) {
      const index = refIndex++;
      refs[index] ??= { current: initial };
      return refs[index];
    },
    useCallback(callback: Function) {
      const index = callbackIndex++;
      callbacks[index] ??= callback;
      return callbacks[index];
    },
    useEffect(callback: () => (() => void) | undefined, dependencies: unknown[]) {
      const index = effectIndex++;
      const previous = effects[index];
      if (!previous || dependencies.some((value, key) => value !== previous.dependencies[key])) {
        scheduled.push(() => {
          previous?.cleanup?.();
          effects[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };

  class MockSocket {
    static OPEN = 1;
    static instances: MockSocket[] = [];
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: (event: { code: number; reason: string }) => void;
    onerror?: () => void;
    messages: { at: number; data: any }[] = [];
    constructor(readonly url: URL) { MockSocket.instances.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
    send(data: string) { this.messages.push({ at: local, data: JSON.parse(data) }); }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose?.({ code, reason });
    }
  }

  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const timer = (callback: () => void, delay: number, repeat: boolean) => {
    const id = ++nextTimer;
    timers.set(id, { due: local + delay, delay, repeat, callback });
    return id;
  };
  replace('__roomTestHooks', hooks);
  replace('WebSocket', MockSocket);
  replace('performance', { now: () => local });
  replace('sessionStorage', { getItem: () => 'self', setItem() {} });
  replace('location', { origin: 'https://watch.test' });
  replace('document', page);
  replace('window', browser);
  replace('setTimeout', (callback: () => void, delay: number) => timer(callback, delay, false));
  replace('setInterval', (callback: () => void, delay: number) => timer(callback, delay, true));
  replace('clearTimeout', (id: number) => timers.delete(id));
  replace('clearInterval', (id: number) => timers.delete(id));

  try {
    const output = await build({
      entryPoints: ['src/room.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
      define: { 'import.meta.env.VITE_API_BASE': 'undefined' },
      plugins: [{
        name: 'room-hooks',
        setup(builder) {
          builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test' }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
            contents: 'export const {useState,useRef,useCallback,useEffect}=globalThis.__roomTestHooks;',
          }));
        },
      }],
    });
    const { useRoom } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
    const render = () => {
      stateIndex = 0;
      refIndex = 0;
      callbackIndex = 0;
      effectIndex = 0;
      const result = useRoom(...props);
      for (const effect of scheduled.splice(0)) effect();
      return result;
    };
    const advance = (milliseconds: number) => {
      const target = local + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, task] = next;
        local = task.due;
        if (task.repeat) task.due += task.delay;
        else timers.delete(id);
        task.callback();
      }
      local = target;
    };
    const unmount = () => {
      for (const effect of effects.splice(0)) effect?.cleanup?.();
    };
    const restore = () => {
      unmount();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as any)[key];
      }
    };
    const snapshot = (id = 'media-a', revision = 1) => ({
      type: 'snapshot', media: { id, url: 'https://media.test/movie.mp4', title: 'Movie', kind: 'video' },
      playback: { paused: false, position: 10, rate: 1, revision, updatedAt: epoch },
      members: [
        { clientId: 'self', name: 'Alice', ready: true, buffering: false },
        { clientId: 'peer', name: 'Bob', ready: true, buffering: false },
      ],
      chat: [], waitTogether: true, userPaused: false,
    });
    const calibrate = (socket: MockSocket) => {
      for (let i = 0; i < 5; i++) {
        const ping = socket.messages.filter(message => message.data.type === 'ping').at(-1)!.data;
        advance(20);
        socket.receive({ type: 'pong', clientTime: ping.clientTime, serverTime: epoch + ping.clientTime + 10 });
        if (i < 4) advance(230);
      }
    };
    return {
      render, advance, restore, unmount, snapshot, calibrate, sockets: MockSocket.instances, epoch,
      now: () => local,
      visibility: (value: string) => {
        visibility = value;
        page.dispatchEvent(new Event('visibilitychange'));
      },
      pageshow: () => browser.dispatchEvent(new Event('pageshow')),
      setProps: (...next: string[]) => { props = next; },
      telemetry: (overrides = {}) => ({
        type: 'telemetry', clientId: 'peer', position: 10.123, paused: false, rate: 1.05,
        revision: 1, measuredAt: epoch + local, receivedAt: epoch + local, ...overrides,
      }),
    };
  } catch (error) {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
    throw error;
  }
}

test('useRoom calibrates a stable clock and leaves capacity for telemetry and controls', async () => {
  const harness = await hookHarness();
  try {
    const initial = harness.render();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(harness.snapshot());
    harness.calibrate(socket);
    const ready = harness.render();
    assert.equal(ready.clockReady, true);
    assert.equal(ready.latency, 20);
    assert.equal(ready.serverNow, initial.serverNow);
    assert.equal(ready.serverNow(), harness.epoch + harness.now());
    assert.equal(ready.room.userPaused, false);
    for (let i = 0; i < 20; i++) {
      harness.advance(1500);
      const ping = socket.messages.filter(message => message.data.type === 'ping').at(-1)!.data;
      socket.receive({ type: 'pong', clientTime: ping.clientTime, serverTime: harness.epoch + (ping.clientTime + harness.now()) / 2 });
      ready.send({ type: 'telemetry', position: 10.123, paused: false, rate: 1, revision: 1, measuredAt: ready.serverNow() });
      ready.send({ type: 'status', ready: true, buffering: false });
    }
    const pings = socket.messages.filter(message => message.data.type === 'ping');
    assert.equal(pings.length, 7);
    const syncs = socket.messages.filter(message => message.data.type === 'sync');
    assert.ok(syncs.length >= 20);
    assert.equal(syncs[1].at - syncs[0].at, 1500);
    const window = { start: 0, count: 0 };
    for (const message of socket.messages) assert.equal(consumeRateLimit(window, message.at), true);
  } finally { harness.restore(); }
});

test('useRoom preserves seek markers independently of revisions and media ids, including legacy snapshots', async () => {
  const harness = await hookHarness();
  try {
    harness.render();
    const socket = harness.sockets[0];
    socket.open();
    const legacy = harness.snapshot();
    socket.receive(legacy);
    assert.equal('seekRevision' in harness.render().room.playback, false);
    const playback = { ...legacy.playback, position: 123.456, revision: 2, seekRevision: 1 };
    socket.receive({ type: 'state', playback });
    assert.deepEqual(harness.render().room.playback, playback);
    for (const change of [
      { paused: true, rate: 1, revision: 3 },
      { paused: false, rate: 1, revision: 4 },
      { paused: false, rate: 2, revision: 5 },
    ]) {
      const next = { ...playback, ...change };
      socket.receive({ type: 'state', playback: next });
      assert.deepEqual(harness.render().room.playback, next);
    }
    const snapshot = harness.snapshot('media-a', 5);
    snapshot.playback.position = 123.456;
    snapshot.playback.rate = 2;
    socket.receive({ ...snapshot, playback: { ...snapshot.playback, seekRevision: 1 } });
    assert.equal(harness.render().room.playback.seekRevision, 1);
    assert.equal(harness.render().room.playback.position, 123.456);
    const selection = harness.snapshot('media-b', 6);
    socket.receive({ ...selection, type: 'state', playback: { ...selection.playback, seekRevision: 0 } });
    assert.equal(harness.render().room.media.id, 'media-b');
    assert.equal(harness.render().room.media.url, legacy.media.url);
    assert.equal(harness.render().room.playback.seekRevision, 0);
  } finally { harness.restore(); }
});

test('peer telemetry expires and invalidates on revisions, same URL selections and peer departure', async () => {
  const harness = await hookHarness();
  try {
    harness.render();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(harness.snapshot());
    harness.calibrate(socket);
    socket.receive(harness.telemetry());
    assert.equal(harness.render().peerTelemetry.position, 10.123);
    harness.advance(5000);
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry({ measuredAt: harness.epoch + harness.now() - 6000 }));
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry({ clientId: 'self' }));
    socket.receive(harness.telemetry({ revision: 0 }));
    socket.receive(harness.telemetry({ measuredAt: harness.epoch + harness.now() + 5000 }));
    socket.receive(harness.telemetry({ rate: '1' }));
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry());
    assert.ok(harness.render().peerTelemetry);
    socket.receive(harness.snapshot('media-b', 2));
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry());
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry({ revision: 2 }));
    assert.ok(harness.render().peerTelemetry);
    socket.receive({ ...harness.snapshot('media-b', 3), type: 'state', userPaused: true });
    assert.equal(harness.render().peerTelemetry, null);
    socket.receive(harness.telemetry({ revision: 3 }));
    assert.ok(harness.render().peerTelemetry);
    socket.receive({ type: 'members', members: [harness.snapshot().members[0]] });
    assert.equal(harness.render().peerTelemetry, null);
  } finally { harness.restore(); }
});

test('reconnect invalidates telemetry and isolates stale socket events; duplicate clients stop reconnecting', async () => {
  const harness = await hookHarness();
  try {
    const original = harness.render();
    const first = harness.sockets[0];
    first.open();
    first.receive(harness.snapshot());
    harness.calibrate(first);
    first.receive(harness.telemetry());
    assert.ok(harness.render().peerTelemetry);
    first.close(1006, 'network');
    assert.equal(harness.render().peerTelemetry, null);
    assert.equal(harness.render().clockReady, false);
    harness.advance(800);
    const second = harness.sockets[1];
    second.open();
    second.receive(harness.snapshot('new-media', 2));
    first.receive(harness.snapshot('stale-media', 0));
    first.receive(harness.telemetry());
    first.onerror?.();
    first.close(4000, 'old connection');
    assert.equal(harness.render().room.media.id, 'new-media');
    assert.equal(harness.render().error, '');
    assert.equal(harness.render().connection, '已连接');
    assert.equal(harness.render().peerTelemetry, null);
    assert.equal(harness.render().serverNow, original.serverNow);
    harness.calibrate(second);
    second.receive(harness.telemetry({ revision: 2 }));
    assert.ok(harness.render().peerTelemetry);
    second.close(4000, '同一客户端已在其他连接重连');
    harness.advance(60000);
    assert.equal(harness.sockets.length, 2);
    assert.equal(harness.render().connection, '连接已关闭');
    assert.equal(harness.render().peerTelemetry, null);
    assert.equal(harness.render().send({ type: 'sync' }), false);
  } finally { harness.restore(); }
});

test('foreground visibility and pageshow resample and sync without duplicate bursts or stale telemetry', async () => {
  const harness = await hookHarness();
  try {
    const initial = harness.render();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(harness.snapshot());
    harness.calibrate(socket);
    socket.receive(harness.telemetry());
    assert.ok(harness.render().peerTelemetry);
    const beforeHidden = socket.messages.length;
    harness.visibility('hidden');
    harness.pageshow();
    assert.equal(socket.messages.length, beforeHidden);
    harness.advance(2000);
    const beforeResume = socket.messages.length;
    const stalePing = socket.messages.filter(message => message.data.type === 'ping').at(-1)!.data;
    harness.visibility('visible');
    assert.deepEqual(socket.messages.slice(beforeResume).map(message => message.data.type), ['ping', 'sync']);
    assert.equal(harness.render().clockReady, false);
    assert.equal(harness.render().latency, null);
    assert.equal(harness.render().peerTelemetry, null);
    harness.pageshow();
    harness.visibility('visible');
    assert.equal(socket.messages.length, beforeResume + 2);
    socket.receive({ type: 'pong', clientTime: stalePing.clientTime, serverTime: harness.epoch + stalePing.clientTime + 10 });
    socket.receive(harness.telemetry());
    assert.equal(harness.render().clockReady, false);
    assert.equal(harness.render().latency, null);
    assert.equal(harness.render().peerTelemetry, null);
    harness.calibrate(socket);
    assert.equal(socket.messages.slice(beforeResume).filter(message => message.data.type === 'ping').length, 5);
    assert.equal(harness.render().clockReady, true);
    assert.equal(harness.render().latency, 20);
    assert.equal(harness.render().serverNow, initial.serverNow);
    assert.equal(initial.serverNow(), harness.epoch + harness.now());
    socket.receive(harness.telemetry());
    assert.ok(harness.render().peerTelemetry);
    harness.advance(1500);
    const beforePageshow = socket.messages.length;
    harness.pageshow();
    assert.deepEqual(socket.messages.slice(beforePageshow).map(message => message.data.type), ['ping', 'sync']);
    assert.equal(harness.render().clockReady, false);
    assert.equal(harness.render().peerTelemetry, null);
    harness.calibrate(socket);
    assert.equal(harness.render().clockReady, true);
    assert.equal(harness.sockets.length, 1);
    const window = { start: 0, count: 0 };
    for (const message of socket.messages) assert.equal(consumeRateLimit(window, message.at), true);
    harness.unmount();
    const beforeUnmountEvents = socket.messages.length;
    harness.visibility('hidden');
    harness.visibility('visible');
    harness.pageshow();
    harness.advance(20000);
    assert.equal(socket.messages.length, beforeUnmountEvents);
    assert.equal(harness.sockets.length, 1);
  } finally { harness.restore(); }
});

test('changing rooms cleans the previous connection and a silent socket reconnects', async () => {
  const harness = await hookHarness();
  try {
    harness.render();
    const first = harness.sockets[0];
    first.open();
    first.receive(harness.snapshot());
    harness.setProps('room-b', 'invite', 'Alice');
    harness.render();
    assert.equal(first.readyState, 3);
    assert.equal(harness.render().room, null);
    first.receive(harness.snapshot('stale'));
    first.close(4000, 'stale');
    const second = harness.sockets[1];
    second.open();
    second.receive(harness.snapshot('room-b-media'));
    harness.advance(11000);
    assert.equal(second.readyState, 3);
    assert.equal(harness.render().connection, '重新连接');
    harness.advance(800);
    assert.equal(harness.sockets.length, 3);
  } finally { harness.restore(); }
});

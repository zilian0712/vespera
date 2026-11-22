import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const workerBundle = build({
  entryPoints: ['worker/index.ts'],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  plugins: [{
    name: 'durable-object-stub',
    setup(builder) {
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cloudflare:workers', namespace: 'test' }));
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
      }));
    },
  }],
}).then(out => import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`));

function createWorkerEnv(allowedOrigin?: string) {
  return workerBundle.then(({ default: worker, Room, resetCreateRoomLimits }) => {
    resetCreateRoomLimits();
    const rooms = new Map<string, any>();

    const makeRoom = (name: string) => {
      let existing = rooms.get(name);
      if (existing) return existing;
      const values = new Map<string, unknown>();
      const sockets: any[] = [];
      let initPromise: Promise<void> = Promise.resolve();
      const storage = {
        get: async (key: string) => values.get(key),
        put: async (key: string, val: unknown) => { values.set(key, structuredClone(val)); },
        setAlarm: async () => {},
        deleteAll: async () => { values.clear(); },
        transaction: async (fn: (tx: any) => Promise<void>) => fn(storage),
      };
      const ctx = {
        storage,
        blockConcurrencyWhile(fn: () => Promise<void>) { initPromise = fn(); },
        getWebSockets: () => sockets,
        acceptWebSocket: (ws: unknown) => { sockets.push(ws); },
      };
      const instance = new Room(ctx, { ALLOWED_ORIGIN: allowedOrigin });
      const stub = {
        instance,
        sockets,
        fetch: async (req: Request) => {
          await initPromise;
          return instance.fetch(req);
        },
      };
      rooms.set(name, stub);
      return stub;
    };

    const env = {
      ALLOWED_ORIGIN: allowedOrigin,
      ASSETS: {
        fetch: async (req: Request) => new Response(`asset:${new URL(req.url).pathname}`, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        }),
      },
      ROOMS: {
        idFromName: (name: string) => name,
        get: (id: string) => makeRoom(id),
      },
    };
    return { worker, env, rooms, resetCreateRoomLimits };
  });
}

test('Worker serves static assets with security headers and handles CORS preflight', async () => {
  const { worker, env } = await createWorkerEnv('https://frontend.example');

  const assetRes = await worker.fetch(new Request('https://watch.test/'), env);
  assert.equal(assetRes.status, 200);
  assert.equal(await assetRes.text(), 'asset:/');
  assert.equal(assetRes.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(assetRes.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(assetRes.headers.get('Permissions-Policy') || '', /microphone=\(self\)/);
  assert.equal(assetRes.headers.get('Content-Security-Policy'), "frame-ancestors 'self'");

  const preflightOk = await worker.fetch(new Request('https://watch.test/api/rooms', {
    method: 'OPTIONS',
    headers: { Origin: 'https://frontend.example' },
  }), env);
  assert.equal(preflightOk.status, 204);
  assert.equal(preflightOk.headers.get('Access-Control-Allow-Origin'), 'https://frontend.example');

  const preflightDenied = await worker.fetch(new Request('https://watch.test/api/rooms', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example' },
  }), env);
  assert.equal(preflightDenied.status, 403);
  const body = await preflightDenied.json() as { error: { code: string } };
  assert.equal(body.error.code, 'ORIGIN_DENIED');
});

test('POST /api/rooms enforces Origin and per-IP rate limiting, and GET /api/rooms/:id probes joinability', async () => {
  const { worker, env } = await createWorkerEnv();

  const missingOrigin = await worker.fetch(new Request('https://watch.test/api/rooms', { method: 'POST' }), env);
  assert.equal(missingOrigin.status, 403);

  const createdRes = await worker.fetch(new Request('https://watch.test/api/rooms', {
    method: 'POST',
    headers: { Origin: 'https://watch.test', 'CF-Connecting-IP': '203.0.113.10' },
  }), env);
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json() as { roomId: string; token: string };
  assert.match(created.roomId, /^[a-f0-9]{32}$/);
  assert.match(created.token, /^[a-f0-9]{64}$/);

  const badIdStatus = await worker.fetch(new Request('https://watch.test/api/rooms/not-a-valid-id'), env);
  assert.equal(badIdStatus.status, 404);

  const wrongTokenStatus = await worker.fetch(new Request(
    `https://watch.test/api/rooms/${created.roomId}?token=wrong&clientId=alice&name=Alice`,
  ), env);
  assert.equal(wrongTokenStatus.status, 403);

  const validStatus = await worker.fetch(new Request(
    `https://watch.test/api/rooms/${created.roomId}?token=${created.token}&clientId=alice&name=Alice`,
  ), env);
  assert.equal(validStatus.status, 200);
  const statusPayload = await validStatus.json() as { ok: boolean; members: number };
  assert.equal(statusPayload.ok, true);
  assert.equal(statusPayload.members, 0);

  // Exhaust 20/min per-IP limit (1 already consumed above).
  for (let i = 1; i < 20; i++) {
    const r = await worker.fetch(new Request('https://watch.test/api/rooms', {
      method: 'POST',
      headers: { Origin: 'https://watch.test', 'CF-Connecting-IP': '203.0.113.10' },
    }), env);
    assert.equal(r.status, 201);
  }
  const rateLimited = await worker.fetch(new Request('https://watch.test/api/rooms', {
    method: 'POST',
    headers: { Origin: 'https://watch.test', 'CF-Connecting-IP': '203.0.113.10' },
  }), env);
  assert.equal(rateLimited.status, 429);

  // Another IP still succeeds independently.
  const otherIp = await worker.fetch(new Request('https://watch.test/api/rooms', {
    method: 'POST',
    headers: { Origin: 'https://watch.test', 'CF-Connecting-IP': '203.0.113.99' },
  }), env);
  assert.equal(otherIp.status, 201);
});

test('Room blocks same-origin web media, supports live profile rename, tags chat clientId, and tolerates socket.close errors', async () => {
  const NativeResponse = globalThis.Response;
  const originalPair = Object.getOwnPropertyDescriptor(globalThis, 'WebSocketPair');

  class MockSocket {
    readyState = 1;
    attachment: unknown;
    messages: any[] = [];
    throwOnClose = false;
    serializeAttachment(val: unknown) { this.attachment = structuredClone(val); }
    deserializeAttachment() { return structuredClone(this.attachment); }
    send(raw: string) { this.messages.push(JSON.parse(raw)); }
    close() {
      this.readyState = 3;
      if (this.throwOnClose) throw new Error('already closed');
    }
  }

  Object.assign(globalThis, { WebSocketPair: class { 0 = new MockSocket(); 1 = new MockSocket(); } });
  globalThis.Response = class extends NativeResponse {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: MockSocket }) {
      if (init?.status === 101) {
        super(null, { status: 200 });
        Object.defineProperty(this, 'status', { value: 101 });
        Object.assign(this, { webSocket: init.webSocket });
      } else {
        super(body, init);
      }
    }
  };

  try {
    const { worker, env, rooms } = await createWorkerEnv();
    const createRes = await worker.fetch(new Request('https://watch.test/api/rooms', {
      method: 'POST',
      headers: { Origin: 'https://watch.test', 'CF-Connecting-IP': '198.51.100.5' },
    }), env);
    const { roomId, token } = await createRes.json() as { roomId: string; token: string };

    const wsRes = await worker.fetch(new Request(
      `https://watch.test/api/rooms/${roomId}/ws?${new URLSearchParams({ token, clientId: 'peer1', name: 'Alice' })}`,
      { headers: { Upgrade: 'websocket', Origin: 'https://watch.test' } },
    ), env);
    assert.equal(wsRes.status, 101);

    const stub = rooms.get(roomId)!;
    const serverSocket = stub.sockets[0] as MockSocket;

    // Same-origin web URL is rejected.
    await stub.instance.webSocketMessage(serverSocket, JSON.stringify({
      type: 'media',
      kind: 'web',
      url: 'https://watch.test/#room=loop',
      title: 'Recursive',
    }));
    assert.equal(serverSocket.messages.at(-1).code, 'INVALID_MESSAGE');
    assert.match(serverSocket.messages.at(-1).message, /不能嵌入当前放映室站点/);

    // External HTTPS web URL succeeds.
    await stub.instance.webSocketMessage(serverSocket, JSON.stringify({
      type: 'media',
      kind: 'web',
      url: 'https://example.org/article',
      title: 'Article',
    }));
    assert.equal(serverSocket.messages.at(-1).media.url, 'https://example.org/article');

    // Chat includes clientId, and profile rename updates both member list and prior chat messages.
    await stub.instance.webSocketMessage(serverSocket, JSON.stringify({ type: 'chat', text: '你好！' }));
    assert.equal(serverSocket.messages.at(-1).message.clientId, 'peer1');
    assert.equal(serverSocket.messages.at(-1).message.name, 'Alice');

    await stub.instance.webSocketMessage(serverSocket, JSON.stringify({ type: 'profile', name: 'Alicia' }));
    const afterProfile = serverSocket.messages.at(-1);
    assert.equal(afterProfile.type, 'state');
    assert.equal(afterProfile.members[0].name, 'Alicia');
    assert.equal(afterProfile.chat[0].name, 'Alicia');

    // webSocketError does not throw even if underlying socket.close() throws.
    serverSocket.throwOnClose = true;
    await assert.doesNotReject(() => stub.instance.webSocketError(serverSocket));
  } finally {
    globalThis.Response = NativeResponse;
    if (originalPair) Object.defineProperty(globalThis, 'WebSocketPair', originalPair);
    else delete (globalThis as any).WebSocketPair;
  }
});

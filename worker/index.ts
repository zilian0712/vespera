import { DurableObject } from 'cloudflare:workers';
import {
  ROOM_TTL, InputError, appendChat, applyControl, boundedText, consumeRateLimit,
  currentPlayback, isAllowedOrigin, parseMessage, reconcilePlayback,
  type Member, type RoomState,
} from './state';

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
  ALLOWED_ORIGIN?: string;
}

interface Attachment extends Member {
  active: boolean;
  limit: { start: number; count: number };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}

function failure(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}

export class Room extends DurableObject<Env> {
  private state: RoomState | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = await ctx.storage.get<RoomState>('room');
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter(socket => socket.readyState === 1 && (socket.deserializeAttachment() as Attachment).active);
  }

  private members(): Member[] {
    return this.sockets().map(socket => {
      const { clientId, name, ready, buffering } = socket.deserializeAttachment() as Attachment;
      return { clientId, name, ready, buffering };
    });
  }

  private active(socket: WebSocket): boolean {
    return this.sockets().includes(socket);
  }

  private send(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      // A closing peer can remain visible until its close callback is delivered.
      try { socket.close(1011, '连接已关闭，请重新连接'); } catch { /* Already closed. */ }
    }
  }

  private broadcast(value: unknown): void {
    for (const socket of this.sockets()) this.send(socket, value);
  }

  private statePayload(now: number): object {
    const state = this.state!;
    return {
      media: state.media,
      playback: currentPlayback(state.playback, now),
      waitTogether: state.waitTogether,
      userPaused: state.userPaused,
      members: this.members(),
      serverTime: now,
    };
  }

  private snapshot(socket: WebSocket): void {
    const state = this.state!;
    this.send(socket, {
      type: 'snapshot', roomId: state.roomId,
      selfId: (socket.deserializeAttachment() as Attachment).clientId,
      ...this.statePayload(Date.now()), chat: state.chat, expiresAt: state.expiresAt,
    });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('room', this.state!);
  }

  private async expire(): Promise<void> {
    for (const socket of this.sockets()) socket.close(4001, '房间已过期');
    await this.ctx.storage.deleteAll();
    this.state = undefined;
  }

  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      const url = new URL(request.url);
      if (url.pathname === '/internal/create' && request.method === 'POST') {
        if (this.state) return failure('ROOM_EXISTS', '房间已经存在', 409);
        const body = await request.json() as { roomId: string; token: string };
        const now = Date.now();
        this.state = {
          roomId: body.roomId, token: body.token, expiresAt: now + ROOM_TTL,
          media: null, playback: { paused: true, position: 0, rate: 1, updatedAt: now, revision: 0, seekRevision: 0 },
          userPaused: true, waitTogether: false, chat: [],
        };
        await this.ctx.storage.transaction(async transaction => {
          await transaction.put('room', this.state!);
          await transaction.setAlarm(this.state!.expiresAt);
        });
        return json({ roomId: body.roomId, token: body.token }, 201);
      }
      if (!this.state) return failure('ROOM_NOT_FOUND', '房间不存在或已经过期', 404);
      if (Date.now() >= this.state.expiresAt) {
        await this.expire();
        return failure('ROOM_EXPIRED', '房间已过期，请创建新房间', 410);
      }
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return failure('WEBSOCKET_REQUIRED', '请使用 WebSocket 连接', 426);
      }
      if (!isAllowedOrigin(request.headers.get('Origin'), request.url, this.env.ALLOWED_ORIGIN)) {
        return failure('ORIGIN_DENIED', '该来源不允许连接房间', 403);
      }
      const token = url.searchParams.get('token');
      if (!token || token !== this.state.token) return failure('INVALID_TOKEN', '邀请链接无效', 403);
      const clientId = url.searchParams.get('clientId') ?? '';
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) return failure('INVALID_CLIENT_ID', 'clientId 必须为 1–64 位字母、数字、下划线或连字符', 400);
      let name: string;
      try { name = boundedText(url.searchParams.get('name'), '昵称', 40); }
      catch (error) { return failure('INVALID_NAME', (error as Error).message, 400); }
      const existing = this.sockets().filter(socket => (socket.deserializeAttachment() as Attachment).clientId === clientId);
      const distinct = new Set(this.members().map(member => member.clientId));
      if (!distinct.has(clientId) && distinct.size >= 2) return failure('ROOM_FULL', '房间最多容纳两位成员', 409);
      for (const socket of existing) {
        socket.serializeAttachment({ ...socket.deserializeAttachment() as Attachment, active: false });
        socket.close(4000, '同一客户端已在其他连接重连');
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ clientId, name, ready: false, buffering: false, active: true, limit: { start: Date.now(), count: 0 } } satisfies Attachment);
      if (reconcilePlayback(this.state, this.members(), Date.now())) await this.save();
      this.snapshot(server);
      this.broadcast({ type: 'state', ...this.statePayload(Date.now()) });
      return new Response(null, { status: 101, webSocket: client });
    });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    await this.serial(async () => {
      if (!this.state || Date.now() >= this.state.expiresAt) {
        if (this.state) await this.expire();
        else socket.close(4001, '房间已过期');
        return;
      }
      if (!this.active(socket)) { socket.close(4000, '连接已被替换'); return; }
      const identity = socket.deserializeAttachment() as Attachment;
      const now = Date.now();
      if (!consumeRateLimit(identity.limit, now)) {
        socket.serializeAttachment(identity);
        this.send(socket, { type: 'error', code: 'RATE_LIMITED', message: '消息过于频繁，请稍后再试', serverTime: now });
        socket.close(1008, '消息过于频繁');
        return;
      }
      socket.serializeAttachment(identity);
      try {
        if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > 32768) throw new InputError('请发送不超过 32 KiB 的 JSON 文本消息');
        const message = parseMessage(data);
        switch (message.type) {
          case 'sync': this.snapshot(socket); return;
          case 'ping': this.send(socket, { type: 'pong', clientTime: message.clientTime, serverTime: now }); return;
          case 'telemetry':
            if (!this.state.media || message.revision !== this.state.playback.revision) return;
            this.broadcast({ ...message, clientId: identity.clientId, receivedAt: now });
            return;
          case 'media':
            this.state.media = { url: message.url, kind: message.kind, title: message.title, id: crypto.randomUUID() };
            this.state.userPaused = true;
            this.state.playback = { paused: true, position: 0, rate: 1, updatedAt: now, revision: this.state.playback.revision + 1, seekRevision: 0 };
            for (const peer of this.sockets()) {
              const attachment = peer.deserializeAttachment() as Attachment;
              peer.serializeAttachment({ ...attachment, ready: false, buffering: false });
            }
            break;
          case 'control': applyControl(this.state, message, this.members(), now); break;
          case 'status':
            socket.serializeAttachment({ ...identity, ready: message.ready, buffering: message.buffering });
            if (!reconcilePlayback(this.state, this.members(), now)) {
              this.broadcast({ type: 'members', members: this.members(), serverTime: now });
              return;
            }
            break;
          case 'settings':
            this.state.waitTogether = message.waitTogether;
            if (!reconcilePlayback(this.state, this.members(), now)) this.state.playback.revision += 1;
            break;
          case 'chat': {
            const chat = {
              id: crypto.randomUUID(), text: message.text, name: identity.name, createdAt: now,
              videoTime: currentPlayback(this.state.playback, now).position,
            };
            this.state.chat = appendChat(this.state.chat, chat);
            await this.save();
            this.broadcast({ type: 'chat', message: chat, serverTime: now });
            return;
          }
        }
        await this.save();
        this.broadcast({ type: 'state', ...this.statePayload(now) });
      } catch (error) {
        if (error instanceof InputError) {
          this.send(socket, { type: 'error', code: 'INVALID_MESSAGE', message: error.message, serverTime: now });
        } else {
          console.error('Room message could not be persisted');
          this.send(socket, { type: 'error', code: 'INTERNAL_ERROR', message: '状态保存失败，请重新连接', serverTime: now });
          socket.close(1011, '状态保存失败');
          throw error;
        }
      }
    });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.serial(async () => {
      socket.serializeAttachment({ ...socket.deserializeAttachment() as Attachment, active: false });
      socket.close(1000, '连接已关闭');
      if (!this.state) return;
      const now = Date.now();
      if (now >= this.state.expiresAt) { await this.expire(); return; }
      if (reconcilePlayback(this.state, this.members(), now)) await this.save();
      this.broadcast({ type: 'state', ...this.statePayload(now) });
    });
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, '连接异常，请重新连接');
    await this.webSocketClose(socket);
  }

  async alarm(): Promise<void> {
    await this.serial(async () => {
      if (this.state && Date.now() < this.state.expiresAt) {
        await this.ctx.storage.setAlarm(this.state.expiresAt);
        return;
      }
      await this.expire();
    });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
    if (!api) return env.ASSETS.fetch(request);
    const origin = request.headers.get('Origin');
    const allowed = isAllowedOrigin(origin, request.url, env.ALLOWED_ORIGIN);
    const cors = new Headers({ 'Cache-Control': 'no-store', 'Vary': 'Origin' });
    if (allowed && origin) {
      cors.set('Access-Control-Allow-Origin', origin);
      cors.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      cors.set('Access-Control-Allow-Headers', 'Content-Type');
    }
    const respond = (response: Response): Response => {
      if (response.status === 101) return response;
      const headers = new Headers(response.headers);
      cors.forEach((value, key) => headers.set(key, value));
      return new Response(response.body, { status: response.status, headers });
    };
    if (origin && !allowed) return respond(failure('ORIGIN_DENIED', '该来源不允许访问 API', 403));
    if (request.method === 'OPTIONS') return respond(new Response(null, { status: 204 }));
    try {
      if (url.pathname === '/api/rooms' && request.method === 'POST') {
        const roomId = crypto.randomUUID().replaceAll('-', '');
        const token = randomToken();
        const room = env.ROOMS.get(env.ROOMS.idFromName(roomId));
        return respond(await room.fetch(new Request(new URL('/internal/create', request.url), {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomId, token }),
        })));
      }
      const match = /^\/api\/rooms\/([a-f0-9]{32})\/ws$/.exec(url.pathname);
      if (match && request.method === 'GET') {
        if (!allowed) return respond(failure('ORIGIN_DENIED', 'WebSocket 连接需要有效的 Origin', 403));
        const room = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
        return respond(await room.fetch(request));
      }
      return respond(failure('NOT_FOUND', 'API 地址或请求方法无效', 404));
    } catch (error) {
      console.error('Room request failed', error instanceof Error ? error.message : 'Unknown error');
      return respond(failure('INTERNAL_ERROR', '服务暂时不可用，请稍后重试', 500));
    }
  },
} satisfies ExportedHandler<Env>;

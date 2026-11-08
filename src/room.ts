import { useCallback, useEffect, useRef, useState } from 'react';
import { ServerClock, TELEMETRY_TTL } from './sync';

export type Media = {
  url: string;
  kind: 'video' | 'web';
  title: string;
  id?: string;
};

export type Playback = {
  paused: boolean;
  position: number;
  rate: number;
  updatedAt: number;
  revision: number;
  seekRevision?: number;
};

export type Member = { clientId: string; name: string; ready: boolean; buffering: boolean };
export type Message = { id: string; text: string; name: string; createdAt: number; videoTime: number };
export type Room = {
  media: Media | null;
  playback: Playback;
  members: Member[];
  chat: Message[];
  waitTogether: boolean;
  userPaused: boolean;
};

export type PeerTelemetry = {
  type: 'telemetry';
  clientId: string;
  position: number;
  paused: boolean;
  rate: number;
  revision: number;
  measuredAt: number;
  receivedAt: number;
};

export const apiBase = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') || location.origin;

export async function createRoom(): Promise<{ roomId: string; token: string }> {
  const response = await fetch(`${apiBase}/api/rooms`, { method: 'POST' });
  let data: unknown;
  try { data = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(response.ok ? '房间服务返回了无效数据，请稍后重试' : `房间服务暂时不可用（HTTP ${response.status}），请检查后端连接`);
  }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object'
      && 'message' in data.error && typeof data.error.message === 'string' ? data.error.message : '';
    throw new Error(message || `创建房间失败（HTTP ${response.status}），请稍后重试`);
  }
  if (!data || typeof data !== 'object' || !('roomId' in data) || typeof data.roomId !== 'string' || !data.roomId
    || !('token' in data) || typeof data.token !== 'string' || !data.token) {
    throw new Error('房间服务返回了无效数据，请稍后重试');
  }
  return { roomId: data.roomId, token: data.token };
}

export function useRoom(roomId: string, token: string, name: string) {
  const [room, setRoom] = useState<Room | null>(null);
  const [connection, setConnection] = useState('未连接');
  const [error, setError] = useState('');
  const [latency, setLatency] = useState<number | null>(null);
  const [clockReady, setClockReady] = useState(false);
  const [peerTelemetry, setPeerTelemetry] = useState<PeerTelemetry | null>(null);
  const offset = useRef(0);
  const socket = useRef<WebSocket | null>(null);
  const clock = useRef<ServerClock | null>(null);
  if (!clock.current) clock.current = new ServerClock();
  const [clientId] = useState(() => {
    let id = sessionStorage.getItem('zhima-client');
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem('zhima-client', id);
    }
    return id;
  });

  const serverNow = useCallback(() => clock.current!.now(), []);
  const send = useCallback((data: object) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(data));
    return true;
  }, []);

  useEffect(() => {
    setRoom(null);
    setPeerTelemetry(null);
    setLatency(null);
    setClockReady(false);
    if (!roomId || !token || !name) {
      setConnection('未连接');
      return;
    }

    let stopped = false;
    let delay = 800;
    let currentRoom: Room | null = null;
    let telemetry: PeerTelemetry | null = null;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let syncTimer: ReturnType<typeof setInterval> | undefined;
    let initialPings: ReturnType<typeof setTimeout>[] = [];
    let resample: (() => void) | undefined;
    let lastResume = -Infinity;
    const pending = new Set<number>();

    const clearTelemetry = () => {
      clearTimeout(expiry);
      telemetry = null;
      setPeerTelemetry(null);
    };

    const clearTimers = () => {
      clearInterval(pingTimer);
      clearInterval(syncTimer);
      clearTimeout(heartbeat);
      for (const timer of initialPings) clearTimeout(timer);
      initialPings = [];
      pending.clear();
      clearTelemetry();
    };

    const updateRoom = (next: Room) => {
      if (currentRoom?.media?.id !== next.media?.id
        || currentRoom?.media?.url !== next.media?.url
        || currentRoom?.playback.revision !== next.playback.revision
        || (telemetry && !next.members.some(member => member.clientId === telemetry!.clientId))) {
        clearTelemetry();
      }
      currentRoom = next;
      setRoom(next);
    };

    const connect = () => {
      if (stopped) return;
      setConnection('连接中');
      const url = new URL(`/api/rooms/${encodeURIComponent(roomId)}/ws`, apiBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.search = new URLSearchParams({ token, clientId, name }).toString();
      const ws = new WebSocket(url);
      socket.current = ws;
      const active = () => !stopped && socket.current === ws;

      const ping = () => {
        if (!active() || ws.readyState !== WebSocket.OPEN) return;
        const sentAt = performance.now();
        for (const time of pending) {
          if (sentAt - time > 10000) pending.delete(time);
        }
        pending.add(sentAt);
        ws.send(JSON.stringify({ type: 'ping', clientTime: sentAt }));
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => {
          if (active() && pending.size) ws.close(4002, '校时请求超时');
        }, 10000);
      };

      const sampleClock = () => {
        if (!active() || ws.readyState !== WebSocket.OPEN) return;
        clearTimers();
        clock.current = new ServerClock();
        setClockReady(false);
        setLatency(null);
        ping();
        initialPings = [250, 500, 750, 1000].map(wait => setTimeout(ping, wait));
        pingTimer = setInterval(ping, 15000);
        syncTimer = setInterval(() => {
          if (!active()) return;
          offset.current = serverNow() - Date.now();
          send({ type: 'sync' });
        }, 1500);
      };
      resample = sampleClock;

      ws.onopen = () => {
        if (!active()) return;
        delay = 800;
        setConnection('已连接');
        setError('');
        sampleClock();
      };

      ws.onmessage = event => {
        if (!active()) return;
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          setError('服务器消息格式异常');
          return;
        }
        if (!data || typeof data !== 'object') {
          setError('服务器消息格式异常');
          return;
        }
        if (data.type === 'pong' && pending.delete(data.clientTime)) {
          if (clock.current!.sample(data.clientTime, performance.now(), data.serverTime)) {
            clearTimeout(heartbeat);
            setLatency(clock.current!.latency);
            setClockReady(clock.current!.ready);
            offset.current = serverNow() - Date.now();
          }
        }
        if (data.type === 'snapshot') {
          updateRoom({
            media: data.media,
            playback: data.playback,
            members: data.members,
            chat: data.chat,
            waitTogether: data.waitTogether,
            userPaused: data.userPaused,
          });
        }
        if (data.type === 'state' && currentRoom) updateRoom({ ...currentRoom, ...data });
        if (data.type === 'members' && currentRoom) updateRoom({ ...currentRoom, members: data.members });
        if (data.type === 'chat' && currentRoom) {
          updateRoom({
            ...currentRoom,
            chat: [...currentRoom.chat.filter(message => message.id !== data.message.id), data.message].slice(-50),
          });
        }
        if (data.type === 'telemetry') {
          if (!clock.current!.ready || !currentRoom?.media || data.clientId === clientId
            || !currentRoom.members.some(member => member.clientId === data.clientId)
            || !Number.isFinite(data.position) || data.position < 0 || data.position > 604800
            || typeof data.paused !== 'boolean'
            || !Number.isFinite(data.rate) || data.rate < 0.1 || data.rate > 8
            || !Number.isSafeInteger(data.revision) || data.revision !== currentRoom.playback.revision
            || !Number.isFinite(data.measuredAt) || !Number.isFinite(data.receivedAt)) return;
          const now = serverNow();
          const age = now - data.measuredAt;
          const receivedAge = now - data.receivedAt;
          if (age < -1000 || age >= TELEMETRY_TTL
            || receivedAge < -1000 || receivedAge >= TELEMETRY_TTL
            || data.receivedAt - data.measuredAt >= TELEMETRY_TTL
            || (telemetry && data.measuredAt <= telemetry.measuredAt)) return;
          clearTelemetry();
          telemetry = data as PeerTelemetry;
          setPeerTelemetry(telemetry);
          expiry = setTimeout(clearTelemetry, Math.min(TELEMETRY_TTL, TELEMETRY_TTL - Math.max(age, receivedAge)));
        }
        if (data.type === 'error') setError(data.message);
      };

      ws.onerror = () => {
        if (active()) setError('连接失败，请检查网络、房间链接和后端配置');
      };
      ws.onclose = event => {
        if (!active()) return;
        socket.current = null;
        clearTimers();
        setClockReady(false);
        setLatency(null);
        if ([4000, 4001, 4003, 4004].includes(event.code)) {
          stopped = true;
          setConnection('连接已关闭');
          setError(event.reason || '房间连接已关闭');
          return;
        }
        setConnection('重新连接');
        reconnect = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 10000);
      };
    };

    const resume = () => {
      if (stopped || document.visibilityState !== 'visible'
        || socket.current?.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      if (now - lastResume < 1500) return;
      lastResume = now;
      resample?.();
      send({ type: 'sync' });
    };

    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pageshow', resume);
    connect();
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', resume);
      clearTimeout(reconnect);
      clearTimers();
      const ws = socket.current;
      socket.current = null;
      ws?.close();
    };
  }, [roomId, token, name, clientId, send, serverNow]);

  return { room, connection, error, latency, offset, clientId, send, serverNow, clockReady, peerTelemetry };
}

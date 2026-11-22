export const MAX_POSITION = 7 * 24 * 60 * 60;
export const ROOM_TTL = 24 * 60 * 60 * 1000;
export const MAX_CHAT = 50;

export interface Playback {
  paused: boolean;
  position: number;
  rate: number;
  updatedAt: number;
  revision: number;
  seekRevision?: number;
}

export interface AnimeMediaMeta {
  bangumiId: number;
  bangumiTitle: string;
  episode: number;
  episodeTitle?: string;
  episodesTotal?: number;
  lineCaption?: string;
  biliCid?: string;
  biliHmtCid?: string;
  qqVid?: string;
}

export interface Media {
  url: string;
  kind: 'video' | 'web';
  title: string;
  id?: string;
  anime?: AnimeMediaMeta;
}

export interface Member {
  clientId: string;
  name: string;
  ready: boolean;
  buffering: boolean;
}

export interface ChatMessage {
  id: string;
  text: string;
  name: string;
  createdAt: number;
  videoTime: number;
  clientId?: string;
}

export interface RoomState {
  roomId: string;
  token: string;
  expiresAt: number;
  media: Media | null;
  playback: Playback;
  userPaused: boolean;
  waitTogether: boolean;
  chat: ChatMessage[];
}

export type ClientMessage =
  | { type: 'sync' }
  | { type: 'ping'; clientTime: number }
  | { type: 'telemetry'; position: number; paused: boolean; rate: number; revision: number; measuredAt: number }
  | { type: 'media'; url: string; kind: 'video' | 'web'; title: string; anime?: AnimeMediaMeta }
  | { type: 'control'; action: 'play' | 'pause' }
  | { type: 'control'; action: 'seek'; position: number }
  | { type: 'control'; action: 'rate'; rate: number }
  | { type: 'status'; ready: boolean; buffering: boolean }
  | { type: 'settings'; waitTogether: boolean }
  | { type: 'profile'; name: string }
  | { type: 'chat'; text: string };

export class InputError extends Error {}

function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function safeInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

export function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max + 64) {
    throw new InputError(`${label}必须为 1–${max} 个字符的有效文本`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new InputError(`${label}必须为 1–${max} 个字符的有效文本`);
  }
  return trimmed;
}

function parseAnimeMeta(raw: unknown): AnimeMediaMeta {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InputError('anime 元数据格式无效');
  }
  const a = raw as Record<string, unknown>;
  if (!safeInt(a.bangumiId, 1, 99_999_999) || !safeInt(a.episode, 1, 99_999)) {
    throw new InputError('番剧 ID 与集数必须为有效正整数');
  }
  const meta: AnimeMediaMeta = {
    bangumiId: a.bangumiId,
    bangumiTitle: boundedText(a.bangumiTitle, '番剧名称', 200),
    episode: a.episode,
  };
  if (a.episodeTitle !== undefined && a.episodeTitle !== '') {
    meta.episodeTitle = boundedText(a.episodeTitle, '分集标题', 200);
  }
  if (a.episodesTotal !== undefined) {
    if (!safeInt(a.episodesTotal, 0, 99_999)) throw new InputError('总集数无效');
    meta.episodesTotal = a.episodesTotal;
  }
  if (a.lineCaption !== undefined && a.lineCaption !== '') {
    meta.lineCaption = boundedText(a.lineCaption, '线路名称', 80);
  }
  if (a.biliCid !== undefined && a.biliCid !== '') {
    if (typeof a.biliCid !== 'string' || !/^\d{1,20}$/.test(a.biliCid)) throw new InputError('biliCid 无效');
    meta.biliCid = a.biliCid;
  }
  if (a.biliHmtCid !== undefined && a.biliHmtCid !== '') {
    if (typeof a.biliHmtCid !== 'string' || !/^\d{1,20}$/.test(a.biliHmtCid)) throw new InputError('biliHmtCid 无效');
    meta.biliHmtCid = a.biliHmtCid;
  }
  if (a.qqVid !== undefined && a.qqVid !== '') {
    if (typeof a.qqVid !== 'string' || a.qqVid.length > 160 || /[\s\u0000-\u001f\u007f]/.test(a.qqVid)) {
      throw new InputError('qqVid 无效');
    }
    meta.qqVid = a.qqVid;
  }
  return meta;
}

export function parseMessage(raw: string, options?: { blockedWebOrigins?: readonly string[] }): ClientMessage {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InputError('消息必须是有效 JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InputError('消息必须是 JSON 对象');
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'sync': return { type: 'sync' };
    case 'ping':
      if (!finite(m.clientTime, 0, Number.MAX_SAFE_INTEGER)) throw new InputError('clientTime 必须是有效毫秒时间戳');
      return { type: 'ping', clientTime: m.clientTime };
    case 'telemetry':
      if (!finite(m.position, 0, MAX_POSITION) || typeof m.paused !== 'boolean'
        || !finite(m.rate, 0.1, 8) || !finite(m.revision, 0, Number.MAX_SAFE_INTEGER)
        || !Number.isSafeInteger(m.revision) || !finite(m.measuredAt, 0, Number.MAX_SAFE_INTEGER)) {
        throw new InputError('telemetry 需要有效 position、paused、rate、revision 和 measuredAt');
      }
      return {
        type: 'telemetry', position: m.position, paused: m.paused, rate: m.rate,
        revision: m.revision, measuredAt: m.measuredAt,
      };
    case 'media': {
      const url = boundedText(m.url, '媒体 URL', 4096);
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new InputError('媒体 URL 格式无效'); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new InputError('媒体必须使用不含账号密码的 HTTPS URL');
      if (m.kind !== 'video' && m.kind !== 'web') throw new InputError('媒体类型必须是 video 或 web');
      if (m.kind === 'web' && options?.blockedWebOrigins?.includes(parsed.origin)) {
        throw new InputError('网页浏览不能嵌入当前放映室站点');
      }
      const result: Extract<ClientMessage, { type: 'media' }> = {
        type: 'media', url: parsed.href, kind: m.kind, title: boundedText(m.title, '标题', 200),
      };
      if (m.anime !== undefined && m.anime !== null) {
        if (m.kind !== 'video') throw new InputError('仅视频模式支持番剧元数据');
        result.anime = parseAnimeMeta(m.anime);
      }
      return result;
    }
    case 'control':
      if (m.action === 'play' || m.action === 'pause') return { type: 'control', action: m.action };
      if (m.action === 'seek' && finite(m.position, 0, MAX_POSITION)) return { type: 'control', action: 'seek', position: m.position };
      if (m.action === 'rate' && finite(m.rate, 0.25, 4)) return { type: 'control', action: 'rate', rate: m.rate };
      throw new InputError('控制无效：seek 需 0–604800 秒，rate 需 0.25–4');
    case 'status':
      if (typeof m.ready !== 'boolean' || typeof m.buffering !== 'boolean') throw new InputError('ready 和 buffering 必须是布尔值');
      return { type: 'status', ready: m.ready, buffering: m.buffering };
    case 'settings':
      if (typeof m.waitTogether !== 'boolean') throw new InputError('waitTogether 必须是布尔值');
      return { type: 'settings', waitTogether: m.waitTogether };
    case 'profile':
      return { type: 'profile', name: boundedText(m.name, '昵称', 40) };
    case 'chat': return { type: 'chat', text: boundedText(m.text, '聊天内容', 500) };
    default: throw new InputError('未知消息类型');
  }
}

export function currentPlayback(playback: Playback, now: number): Playback {
  const elapsed = Math.max(0, now - playback.updatedAt) / 1000;
  return {
    ...playback,
    position: Math.min(MAX_POSITION, playback.position + (playback.paused ? 0 : elapsed * playback.rate)),
    updatedAt: now,
  };
}

export function reconcilePlayback(state: RoomState, members: Member[], now: number): boolean {
  const blocked = state.waitTogether && members.some(member => !member.ready || member.buffering);
  const paused = state.userPaused || blocked || !state.media;
  if (paused === state.playback.paused) return false;
  state.playback = { ...currentPlayback(state.playback, now), paused, revision: state.playback.revision + 1 };
  return true;
}

export function applyControl(state: RoomState, message: Extract<ClientMessage, { type: 'control' }>, members: Member[], now: number): void {
  if (!state.media) throw new InputError('请先选择媒体');
  const playback = currentPlayback(state.playback, now);
  if (message.action === 'play') state.userPaused = false;
  if (message.action === 'pause') state.userPaused = true;
  if (message.action === 'seek') {
    playback.position = message.position;
    playback.seekRevision = (playback.seekRevision ?? 0) + 1;
  }
  if (message.action === 'rate') playback.rate = message.rate;
  playback.paused = state.userPaused || (state.waitTogether && members.some(member => !member.ready || member.buffering));
  playback.revision += 1;
  state.playback = playback;
}

export function appendChat(history: ChatMessage[], message: ChatMessage): ChatMessage[] {
  return [...history, message].slice(-MAX_CHAT);
}

export function consumeRateLimit(window: { start: number; count: number }, now: number): boolean {
  if (now - window.start >= 10_000) {
    window.start = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= 60;
}

export function isAllowedOrigin(origin: string | null, requestUrl: string, configured?: string): boolean {
  if (!origin) return false;
  return origin === new URL(requestUrl).origin || (!!configured && origin === configured);
}

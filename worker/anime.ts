import {
  decodeAnichDanmaku, decodeBangumiEpisodes, decodeBangumiLatest,
  decodeBangumiList, decodeBangumiRelated, decodeBilibiliDanmaku, decodeVodList,
  type BangumiEpisode, type BangumiRelatedItem, type NormalizedDanmakuItem,
} from './protobuf';

export interface AnimeEnv {
  ANICH_API_BASE?: string;
  ANICH_USER_AGENT?: string;
  ANICH_BILI_DANMAKU_BASE?: string;
  ANICH_QQ_DANMAKU_BASE?: string;
}

export interface BangumiTag {
  name: string;
  count: number;
  image: string;
}

export interface BangumiDetail {
  id: number;
  title: string;
  image: string;
  airdate: number;
  genres: string[];
  marks: { name: string; count: number }[];
  rating: { site: string; score: number }[];
  overview: string;
  episode: number;
  episodesTotal: number;
  status: string;
}

const DEFAULT_MIRRORS = [
  'https://ani.emmmm.eu.org',
  'https://api.emmmm.eu.org',
  'https://api.500403.xyz',
];
const DEFAULT_UA = 'cx.xs.open Android 1.0.0';
const DEFAULT_BILI_BASE = 'https://bili-dm.emmmm.eu.org';
const DEFAULT_QQ_BASE = 'https://dm.video.qq.com';
const UPSTREAM_TIMEOUT_MS = 7000;
const MAX_DANMAKU_ITEMS = 4000;

class UpstreamError extends Error {
  constructor(message: string, readonly status = 502, readonly code = 'UPSTREAM_UNAVAILABLE') {
    super(message);
  }
}

function parseMirrors(configured?: string): string[] {
  const candidates = (configured ? configured.split(',') : DEFAULT_MIRRORS)
    .map(item => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const valid: string[] = [];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) {
        valid.push(parsed.origin);
      }
    } catch {
      // Ignore malformed mirror entry.
    }
  }
  return valid.length ? valid : DEFAULT_MIRRORS;
}

function checkUpstreamJsonError(bytes: Uint8Array): string | null {
  if (!bytes.byteLength || bytes[0] !== 0x7b /* '{' */) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && parsed.error === true) {
      return typeof parsed.message === 'string' && parsed.message ? parsed.message : 'upstream error';
    }
  } catch {
    // Binary protobuf payload happened to start with 0x7b (field 15, wire 3); not JSON.
  }
  return null;
}

async function fetchWithTimeout(url: URL, headers: HeadersInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), { method: 'GET', headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAniChBytes(path: string, search: URLSearchParams | undefined, env: AnimeEnv): Promise<Uint8Array> {
  const mirrors = parseMirrors(env.ANICH_API_BASE);
  const ua = env.ANICH_USER_AGENT?.trim() || DEFAULT_UA;
  let lastReason = '';
  for (const base of mirrors) {
    const url = new URL(path, `${base}/`);
    if (search) {
      search.forEach((value, key) => {
        if (value !== '') url.searchParams.set(key, value);
      });
    }
    try {
      const response = await fetchWithTimeout(url, { 'User-Agent': ua, Accept: '*/*' });
      const bytes = new Uint8Array(await response.arrayBuffer());
      const jsonErr = checkUpstreamJsonError(bytes);
      if (!response.ok || jsonErr) {
        lastReason = jsonErr || `HTTP ${response.status}`;
        continue;
      }
      return bytes;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : 'network error';
    }
  }
  const unauthorized = /unauthorized/i.test(lastReason);
  throw new UpstreamError(
    unauthorized
      ? '上游番剧接口拒绝访问（unauthorized），可稍后重试或在后端配置可用的 ANICH_API_BASE 镜像；当前仍可使用视频直链观看'
      : '番剧源暂时不可用，请稍后重试或直接使用视频直链观看',
    502,
    unauthorized ? 'UPSTREAM_UNAUTHORIZED' : 'UPSTREAM_UNAVAILABLE',
  );
}

async function fetchAniChJson(path: string, search: URLSearchParams | undefined, env: AnimeEnv): Promise<unknown> {
  const bytes = await fetchAniChBytes(path, search, env);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UpstreamError('番剧源返回了无效的 JSON 数据');
  }
}

function normalizePositiveInt(raw: string | null, fallback?: number, max = 99_999_999): number | null {
  if (raw === null || raw === '') return fallback ?? null;
  if (!/^\d+$/.test(raw)) return null;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0 || num > max) return null;
  return num;
}

function normalizeDetail(id: number, raw: unknown): BangumiDetail {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const genres = Array.isArray(obj.genres)
    ? obj.genres.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
  const marks = Array.isArray(obj.marks)
    ? obj.marks
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map(item => ({
        name: typeof item.name === 'string' ? item.name : '',
        count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 0,
      }))
      .filter(item => item.name)
    : [];
  const rating = Array.isArray(obj.rating)
    ? obj.rating
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map(item => ({
        site: typeof item.site === 'string' ? item.site : '',
        score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : 0,
      }))
      .filter(item => item.site)
    : [];
  return {
    id: typeof obj.id === 'number' && obj.id > 0 ? obj.id : id,
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : `番剧 #${id}`,
    image: typeof obj.image === 'string' ? obj.image : '',
    airdate: typeof obj.airdate === 'number' && Number.isFinite(obj.airdate) ? obj.airdate : 0,
    genres,
    marks,
    rating,
    overview: typeof obj.overview === 'string' ? obj.overview.trim() : '',
    episode: typeof obj.episode === 'number' && Number.isFinite(obj.episode) ? obj.episode : 0,
    episodesTotal: typeof obj.episodes_total === 'number' && Number.isFinite(obj.episodes_total) ? obj.episodes_total : 0,
    status: typeof obj.status === 'string' ? obj.status : '',
  };
}

function parseQqDanmaku(raw: unknown): NormalizedDanmakuItem[] {
  if (!raw || typeof raw !== 'object') return [];
  const list = (raw as Record<string, unknown>).barrage_list;
  if (!Array.isArray(list)) return [];
  const items: NormalizedDanmakuItem[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const text = typeof item.content === 'string' ? item.content.trim() : '';
    const offsetMs = Number(item.time_offset ?? 0);
    if (!text || !Number.isFinite(offsetMs) || offsetMs < 0) continue;
    const rickType = typeof item.rick_type === 'number' ? item.rick_type : 1;
    items.push({
      id: `qq-${typeof item.id === 'string' && item.id ? item.id : items.length}`,
      time: Math.round(offsetMs) / 1000,
      text: text.slice(0, 200),
      color: '#faf9f5',
      mode: rickType > 1 ? 'top' : 'scroll',
    });
  }
  return items;
}

function jsonResponse(value: unknown, status = 200, cacheSeconds = 0): Response {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return jsonResponse({ error: { code, message } }, status, 0);
}

export async function handleAnimeRequest(request: Request, env: AnimeEnv): Promise<Response> {
  if (request.method !== 'GET') {
    return errorResponse('METHOD_NOT_ALLOWED', '番剧接口仅支持 GET 请求', 405);
  }
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    if (path === '/api/anime/latest') {
      const bytes = await fetchAniChBytes('/bangumi/latest', undefined, env);
      const rawItems = decodeBangumiLatest(bytes);
      const items = rawItems.map(item => ({
        id: item.id,
        title: item.name || item.title,
        episodeTitle: item.name ? item.title : '',
        ep: item.ep,
        image: item.image,
        status: item.ep > 0 ? `更新至 ${item.ep} 话` : '',
        updatedAt: item.airdate,
      }));
      return jsonResponse({ items }, 200, 60);
    }

    if (path === '/api/anime/tags') {
      const skip = normalizePositiveInt(url.searchParams.get('skip'), 0);
      if (skip === null) return errorResponse('INVALID_SKIP', 'skip 参数必须为非负整数', 400);
      const type = (url.searchParams.get('type') || 'genre').trim().slice(0, 24);
      const raw = await fetchAniChJson('/bangumi/tag', new URLSearchParams({ type, skip: String(skip) }), env);
      const tags: BangumiTag[] = Array.isArray(raw)
        ? raw
          .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
          .map(item => ({
            name: typeof item.name === 'string' ? item.name.trim() : '',
            count: typeof item.count === 'number' && Number.isFinite(item.count) ? item.count : 0,
            image: typeof item.image === 'string' ? item.image : '',
          }))
          .filter(item => item.name)
        : [];
      return jsonResponse({ tags }, 200, 300);
    }

    if (path === '/api/anime/list') {
      const skip = normalizePositiveInt(url.searchParams.get('skip'), 0);
      if (skip === null) return errorResponse('INVALID_SKIP', 'skip 参数必须为非负整数', 400);
      const query = new URLSearchParams({ skip: String(skip) });
      for (const key of ['type', 'lang', 'year', 'genre', 'mark'] as const) {
        const value = url.searchParams.get(key)?.trim();
        if (value) query.set(key, value.slice(0, 40));
      }
      const bytes = await fetchAniChBytes('/bangumi/list', query, env);
      const decoded = decodeBangumiList(bytes);
      return jsonResponse({
        items: decoded.data,
        prev: decoded.prev > 0 || skip > 0,
        next: decoded.next > 0,
      }, 200, 60);
    }

    if (path === '/api/anime/search') {
      const keyword = url.searchParams.get('keyword')?.trim() || '';
      if (!keyword || keyword.length > 80) {
        return errorResponse('INVALID_KEYWORD', '搜索关键词需为 1–80 个字符', 400);
      }
      const skip = normalizePositiveInt(url.searchParams.get('skip'), 0);
      if (skip === null) return errorResponse('INVALID_SKIP', 'skip 参数必须为非负整数', 400);
      const bytes = await fetchAniChBytes('/bangumi/search', new URLSearchParams({ keyword, skip: String(skip) }), env);
      const decoded = decodeBangumiList(bytes);
      return jsonResponse({
        items: decoded.data,
        prev: decoded.prev > 0 || skip > 0,
        next: decoded.next > 0,
      }, 200, 60);
    }

    const detailMatch = /^\/api\/anime\/(\d{1,10})$/.exec(path);
    if (detailMatch) {
      const id = normalizePositiveInt(detailMatch[1]);
      if (!id || id <= 0) return errorResponse('INVALID_ID', '番剧 ID 无效', 400);
      const [detailRes, episodesRes, relatedRes] = await Promise.allSettled([
        fetchAniChJson(`/bangumi/detail/${id}`, undefined, env),
        fetchAniChBytes(`/bangumi/episodes/${id}`, undefined, env),
        fetchAniChBytes(`/bangumi/related/${id}`, undefined, env),
      ]);
      if (detailRes.status === 'rejected' && episodesRes.status === 'rejected') {
        throw detailRes.reason;
      }
      const rawEpisodes: BangumiEpisode[] = episodesRes.status === 'fulfilled'
        ? decodeBangumiEpisodes(episodesRes.value)
        : [];
      const episodes = rawEpisodes.map(ep => {
        const findSite = (name: string) => ep.sites.find(s => s.site === name)?.id || '';
        return {
          episode: ep.sort,
          title: ep.title,
          overview: ep.overview,
          image: ep.image,
          airdate: ep.airdate,
          duration: ep.duration,
          bili: findSite('bili'),
          biliHmt: findSite('bili_hmt'),
          qq: findSite('qq'),
          iqiyi: findSite('iqiyi'),
          youku: findSite('youku'),
        };
      });
      const detail = detailRes.status === 'fulfilled'
        ? normalizeDetail(id, detailRes.value)
        : normalizeDetail(id, { id, episodes_total: episodes.length, episode: episodes.length });
      const rawRelated: BangumiRelatedItem[] = relatedRes.status === 'fulfilled'
        ? decodeBangumiRelated(relatedRes.value)
        : [];
      const related = rawRelated.map(rel => ({
        id: rel.id,
        title: rel.title || rel.name,
        image: rel.image,
        relation: rel.type || rel.tagline,
      }));
      return jsonResponse({ detail, episodes, related }, 200, 120);
    }

    const vodMatch = /^\/api\/anime\/(\d{1,10})\/episodes\/(\d{1,6})\/vod$/.exec(path);
    if (vodMatch) {
      const id = normalizePositiveInt(vodMatch[1]);
      const episode = normalizePositiveInt(vodMatch[2], undefined, 99999);
      if (!id || id <= 0 || !episode || episode <= 0) {
        return errorResponse('INVALID_EPISODE', '番剧 ID 或集数无效', 400);
      }
      const bytes = await fetchAniChBytes(`/vod/${id}/${episode}`, undefined, env);
      const lines = decodeVodList(bytes);
      return jsonResponse({ lines }, 200, 30);
    }

    const danmakuMatch = /^\/api\/anime\/(\d{1,10})\/episodes\/(\d{1,6})\/danmaku$/.exec(path);
    if (danmakuMatch) {
      const id = normalizePositiveInt(danmakuMatch[1]);
      const episode = normalizePositiveInt(danmakuMatch[2], undefined, 99999);
      const skip = normalizePositiveInt(url.searchParams.get('skip'), 0);
      const segment = normalizePositiveInt(url.searchParams.get('segment'), 1, 200);
      if (!id || id <= 0 || !episode || episode <= 0 || skip === null || !segment || segment <= 0) {
        return errorResponse('INVALID_DANMAKU_QUERY', '弹幕请求参数无效', 400);
      }
      const biliCid = (url.searchParams.get('biliCid') || '').trim();
      const qqRaw = (url.searchParams.get('qqVid') || '').trim();
      const qqVid = qqRaw ? qqRaw.split('/').filter(Boolean).at(-1) || '' : '';

      const tasks: Promise<{ kind: 'anich' | 'bili' | 'qq'; items: NormalizedDanmakuItem[] }>[] = [
        fetchAniChBytes('/danmaku', new URLSearchParams({
          bangumi: String(id),
          episode: String(episode),
          skip: String(skip),
        }), env).then(bytes => ({ kind: 'anich' as const, items: decodeAnichDanmaku(bytes) })),
      ];

      if (/^\d{1,20}$/.test(biliCid)) {
        const biliBase = (env.ANICH_BILI_DANMAKU_BASE || DEFAULT_BILI_BASE).trim().replace(/\/+$/, '');
        const biliUrl = new URL('/', `${biliBase}/`);
        biliUrl.searchParams.set('type', '1');
        biliUrl.searchParams.set('oid', biliCid);
        biliUrl.searchParams.set('segment_index', String(segment));
        tasks.push(
          fetchWithTimeout(biliUrl, { Accept: '*/*' })
            .then(async res => {
              if (!res.ok) return { kind: 'bili' as const, items: [] };
              const bytes = new Uint8Array(await res.arrayBuffer());
              if (checkUpstreamJsonError(bytes)) return { kind: 'bili' as const, items: [] };
              return { kind: 'bili' as const, items: decodeBilibiliDanmaku(bytes) };
            }),
        );
      }

      if (/^[A-Za-z0-9_-]{1,64}$/.test(qqVid)) {
        const qqBase = (env.ANICH_QQ_DANMAKU_BASE || DEFAULT_QQ_BASE).trim().replace(/\/+$/, '');
        const start = 30000 * (segment - 1);
        const end = 30000 * segment;
        const qqUrl = new URL(`/barrage/segment/${encodeURIComponent(qqVid)}/t/v1/${start}/${end}`, `${qqBase}/`);
        tasks.push(
          fetchWithTimeout(qqUrl, { Accept: 'application/json' })
            .then(async res => {
              if (!res.ok) return { kind: 'qq' as const, items: [] };
              return { kind: 'qq' as const, items: parseQqDanmaku(await res.json()) };
            }),
        );
      }

      const settled = await Promise.allSettled(tasks);
      const sources = { anich: 0, bili: 0, qq: 0 };
      const merged: NormalizedDanmakuItem[] = [];
      for (const entry of settled) {
        if (entry.status !== 'fulfilled') continue;
        sources[entry.value.kind] += entry.value.items.length;
        merged.push(...entry.value.items);
      }
      merged.sort((a, b) => a.time - b.time);
      return jsonResponse({ items: merged.slice(0, MAX_DANMAKU_ITEMS), sources }, 200, 120);
    }

    return errorResponse('NOT_FOUND', '番剧接口地址无效', 404);
  } catch (error) {
    if (error instanceof UpstreamError) {
      return errorResponse(error.code, error.message, error.status);
    }
    return errorResponse('ANIME_ERROR', '番剧数据解析失败，请稍后重试', 502);
  }
}

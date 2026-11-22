import type { AnimeMediaMeta } from './room';

export interface AnimeLatestItem {
  id: number;
  title: string;
  episodeTitle?: string;
  ep?: number;
  image: string;
  status: string;
  updatedAt: number;
}

export interface AnimeListItem {
  id: number;
  title: string;
  image: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  tagline: string;
}

export interface AnimeTag {
  name: string;
  count: number;
  image: string;
}

export interface AnimeEpisode {
  episode: number;
  title: string;
  image: string;
  airdate: number;
  bili: string;
  biliHmt: string;
  qq: string;
  iqiyi: string;
  youku: string;
}

export interface AnimeRelatedItem {
  id: number;
  title: string;
  image: string;
  relation: string;
}

export interface AnimeDetail {
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

export interface AnimeDetailBundle {
  detail: AnimeDetail;
  episodes: AnimeEpisode[];
  related: AnimeRelatedItem[];
}

export interface AnimeVodLine {
  url: string;
  sort: number;
  type: string;
  caption: string;
}

export interface TimelineDanmakuItem {
  id: string;
  time: number;
  text: string;
  color: string;
  mode: 'scroll' | 'top' | 'bottom';
}

export interface AnimeDanmakuResponse {
  items: TimelineDanmakuItem[];
  sources: { anich: number; bili: number; qq: number };
}

function apiBase(): URL {
  const configured = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE?.trim();
  const fallback = typeof location !== 'undefined' ? location.origin : 'https://localhost';
  return new URL(configured || fallback);
}

async function requestAnimeJson<T>(path: string, params?: Record<string, string | number | undefined>, signal?: AbortSignal): Promise<T> {
  const url = new URL(path, apiBase());
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, { method: 'GET', signal });
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  if (!response.ok) {
    const errObj = obj?.error && typeof obj.error === 'object' ? obj.error as Record<string, unknown> : null;
    const msg = typeof errObj?.message === 'string' && errObj.message.trim()
      ? errObj.message.trim()
      : `番剧服务暂时不可用（HTTP ${response.status}）`;
    throw new Error(msg);
  }
  if (!obj) throw new Error('番剧服务返回了无效响应');
  return obj as T;
}

export async function fetchAnimeLatest(signal?: AbortSignal): Promise<AnimeLatestItem[]> {
  const data = await requestAnimeJson<{ items?: AnimeLatestItem[] }>('/api/anime/latest', undefined, signal);
  return Array.isArray(data.items) ? data.items : [];
}

export async function fetchAnimeTags(type = 'genre', skip = 0, signal?: AbortSignal): Promise<AnimeTag[]> {
  const data = await requestAnimeJson<{ tags?: AnimeTag[] }>('/api/anime/tags', { type, skip }, signal);
  return Array.isArray(data.tags) ? data.tags : [];
}

export async function fetchAnimeList(
  filters: { skip?: number; type?: string; lang?: string; year?: string; genre?: string; mark?: string },
  signal?: AbortSignal,
): Promise<{ items: AnimeListItem[]; prev: boolean; next: boolean }> {
  const data = await requestAnimeJson<{ items?: AnimeListItem[]; prev?: boolean; next?: boolean }>(
    '/api/anime/list',
    filters,
    signal,
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    prev: Boolean(data.prev),
    next: Boolean(data.next),
  };
}

export async function fetchAnimeSearch(
  keyword: string,
  skip = 0,
  signal?: AbortSignal,
): Promise<{ items: AnimeListItem[]; prev: boolean; next: boolean }> {
  const data = await requestAnimeJson<{ items?: AnimeListItem[]; prev?: boolean; next?: boolean }>(
    '/api/anime/search',
    { keyword, skip },
    signal,
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    prev: Boolean(data.prev),
    next: Boolean(data.next),
  };
}

export async function fetchAnimeDetail(id: number, signal?: AbortSignal): Promise<AnimeDetailBundle> {
  return requestAnimeJson<AnimeDetailBundle>(`/api/anime/${id}`, undefined, signal);
}

export async function fetchAnimeVod(id: number, episode: number, signal?: AbortSignal): Promise<AnimeVodLine[]> {
  const data = await requestAnimeJson<{ lines?: AnimeVodLine[] }>(`/api/anime/${id}/episodes/${episode}/vod`, undefined, signal);
  return Array.isArray(data.lines) ? data.lines : [];
}

export async function fetchAnimeDanmaku(
  id: number,
  episode: number,
  options?: { skip?: number; biliCid?: string; qqVid?: string; segment?: number },
  signal?: AbortSignal,
): Promise<AnimeDanmakuResponse> {
  const data = await requestAnimeJson<AnimeDanmakuResponse>(
    `/api/anime/${id}/episodes/${episode}/danmaku`,
    options,
    signal,
  );
  return {
    items: Array.isArray(data.items) ? data.items : [],
    sources: data.sources ?? { anich: 0, bili: 0, qq: 0 },
  };
}

export function isHttpsPlayableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function selectPlayableVodLines(lines: AnimeVodLine[]): AnimeVodLine[] {
  const httpsLines = lines.filter(line => isHttpsPlayableUrl(line.url));
  const score = (line: AnimeVodLine): number => {
    let s = line.type === 'parse' ? 0 : 10;
    if (/\.mp4(?:$|[?#])/i.test(line.url)) s += 4;
    else if (/\.m3u8(?:$|[?#])/i.test(line.url)) s += 3;
    return s;
  };
  return [...httpsLines].sort((a, b) => score(b) - score(a) || a.sort - b.sort);
}

export function buildAnimeMediaMeta(
  detail: Pick<AnimeDetail, 'id' | 'title' | 'episodesTotal'>,
  episode: Pick<AnimeEpisode, 'episode' | 'title' | 'bili' | 'biliHmt' | 'qq'>,
  lineCaption?: string,
  episodesFallbackTotal?: number,
): AnimeMediaMeta {
  const meta: AnimeMediaMeta = {
    bangumiId: detail.id,
    bangumiTitle: detail.title,
    episode: episode.episode,
  };
  if (episode.title?.trim()) meta.episodeTitle = episode.title.trim().slice(0, 200);
  const total = detail.episodesTotal || episodesFallbackTotal || 0;
  if (total > 0) meta.episodesTotal = total;
  if (lineCaption?.trim()) meta.lineCaption = lineCaption.trim().slice(0, 80);
  if (/^\d{1,20}$/.test(episode.bili)) meta.biliCid = episode.bili;
  if (/^\d{1,20}$/.test(episode.biliHmt)) meta.biliHmtCid = episode.biliHmt;
  if (episode.qq?.trim()) {
    const qqVid = episode.qq.split('/').filter(Boolean).at(-1) || '';
    if (/^[A-Za-z0-9_-]{1,64}$/.test(qqVid)) meta.qqVid = qqVid;
  }
  return meta;
}

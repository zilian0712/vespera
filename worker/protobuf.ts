const utf8Decoder = new TextDecoder('utf-8');

export class ProtobufError extends Error {}

export class ProtoReader {
  private readonly view: DataView;
  private offset = 0;
  private readonly end: number;

  constructor(private readonly bytes: Uint8Array, start = 0, end = bytes.byteLength) {
    if (start < 0 || end < start || end > bytes.byteLength) {
      throw new ProtobufError('Invalid protobuf slice bounds');
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
    this.end = end;
  }

  get eof(): boolean {
    return this.offset >= this.end;
  }

  tag(): { field: number; wire: number } {
    const value = this.uint32();
    const field = value >>> 3;
    const wire = value & 0x7;
    if (field === 0) throw new ProtobufError('Invalid protobuf field number 0');
    return { field, wire };
  }

  varintBigInt(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.end) throw new ProtobufError('Truncated protobuf varint');
      const byte = this.bytes[this.offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new ProtobufError('Protobuf varint exceeds 10 bytes');
  }

  uint32(): number {
    return Number(this.varintBigInt() & 0xffffffffn) >>> 0;
  }

  int32(): number {
    return Number(this.varintBigInt() & 0xffffffffn) | 0;
  }

  bool(): boolean {
    return this.varintBigInt() !== 0n;
  }

  double(): number {
    if (this.offset + 8 > this.end) throw new ProtobufError('Truncated protobuf double');
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  bytesSlice(): ProtoReader {
    const length = this.uint32();
    if (this.offset + length > this.end) throw new ProtobufError('Truncated protobuf length-delimited field');
    const sub = new ProtoReader(this.bytes, this.offset, this.offset + length);
    this.offset += length;
    return sub;
  }

  string(): string {
    const length = this.uint32();
    if (this.offset + length > this.end) throw new ProtobufError('Truncated protobuf string');
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return utf8Decoder.decode(slice);
  }

  skip(wire: number): void {
    switch (wire) {
      case 0:
        this.varintBigInt();
        return;
      case 1:
        if (this.offset + 8 > this.end) throw new ProtobufError('Truncated 64-bit field');
        this.offset += 8;
        return;
      case 2: {
        const length = this.uint32();
        if (this.offset + length > this.end) throw new ProtobufError('Truncated length-delimited field');
        this.offset += length;
        return;
      }
      case 5:
        if (this.offset + 4 > this.end) throw new ProtobufError('Truncated 32-bit field');
        this.offset += 4;
        return;
      default:
        throw new ProtobufError(`Unsupported protobuf wire type: ${wire}`);
    }
  }
}

export interface BangumiListItem {
  id: number;
  title: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  image: string;
  tagline: string;
}

export interface BangumiListResponse {
  data: BangumiListItem[];
  prev: number;
  next: number;
}

export interface BangumiLatestItem {
  status: boolean;
  id: number;
  ep: number;
  airdate: number;
  duration: number;
  image: string;
  title: string;
  name: string;
}

export interface BangumiEpisodeSite {
  site: string;
  id: string;
}

export interface BangumiEpisodeRating {
  site: string;
  score: number;
  count: number;
}

export interface BangumiEpisode {
  status: boolean;
  sort: number;
  airdate: number;
  duration: number;
  sites: BangumiEpisodeSite[];
  rating: BangumiEpisodeRating[];
  image: string;
  title: string;
  overview: string;
}

export interface BangumiRelatedItem {
  id: number;
  title: string;
  name: string;
  episode: number;
  episodesTotal: number;
  status: string;
  date: number;
  image: string;
  tagline: string;
  type: string;
}

export interface RawVodItem {
  url: string;
  sort: number;
  type: string;
  caption: string;
}

export interface DecodedVodLine {
  url: string;
  sort: number;
  type: string;
  caption: string;
}

export interface NormalizedDanmakuItem {
  id: string;
  time: number;
  text: string;
  color: string;
  mode: 'scroll' | 'top' | 'bottom';
}

function readBangumiListItem(reader: ProtoReader): BangumiListItem {
  const item: BangumiListItem = {
    id: 0, title: '', episode: 0, episodesTotal: 0, status: '', date: 0, image: '', tagline: '',
  };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 0) item.id = reader.uint32();
    else if (field === 2 && wire === 2) item.title = reader.string();
    else if (field === 3 && wire === 0) item.episode = reader.uint32();
    else if (field === 4 && wire === 0) item.episodesTotal = reader.uint32();
    else if (field === 5 && wire === 2) item.status = reader.string();
    else if (field === 6 && wire === 1) item.date = reader.double();
    else if (field === 7 && wire === 2) item.image = reader.string();
    else if (field === 8 && wire === 2) item.tagline = reader.string();
    else reader.skip(wire);
  }
  return item;
}

export function decodeBangumiList(buffer: ArrayBuffer | Uint8Array): BangumiListResponse {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const result: BangumiListResponse = { data: [], prev: 0, next: 0 };
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) result.data.push(readBangumiListItem(reader.bytesSlice()));
    else if (field === 2 && wire === 0) result.prev = reader.uint32();
    else if (field === 3 && wire === 0) result.next = reader.uint32();
    else reader.skip(wire);
  }
  return result;
}

export function decodeBangumiLatest(buffer: ArrayBuffer | Uint8Array): BangumiLatestItem[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const list: BangumiLatestItem[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      const item: BangumiLatestItem = {
        status: false, id: 0, ep: 0, airdate: 0, duration: 0, image: '', title: '', name: '',
      };
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 0) item.status = sub.bool();
        else if (tag.field === 2 && tag.wire === 0) item.id = sub.uint32();
        else if (tag.field === 3 && tag.wire === 0) item.ep = sub.uint32();
        else if (tag.field === 4 && tag.wire === 1) item.airdate = sub.double();
        else if (tag.field === 5 && tag.wire === 0) item.duration = sub.uint32();
        else if (tag.field === 6 && tag.wire === 2) item.image = sub.string();
        else if (tag.field === 7 && tag.wire === 2) item.title = sub.string();
        else if (tag.field === 8 && tag.wire === 2) item.name = sub.string();
        else sub.skip(tag.wire);
      }
      if (item.id > 0) list.push(item);
    } else reader.skip(wire);
  }
  return list;
}

export function decodeBangumiEpisodes(buffer: ArrayBuffer | Uint8Array): BangumiEpisode[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const episodes: BangumiEpisode[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      const ep: BangumiEpisode = {
        status: false, sort: 0, airdate: 0, duration: 0, sites: [], rating: [], image: '', title: '', overview: '',
      };
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 0) ep.status = sub.bool();
        else if (tag.field === 2 && tag.wire === 0) ep.sort = sub.uint32();
        else if (tag.field === 3 && tag.wire === 1) ep.airdate = sub.double();
        else if (tag.field === 4 && tag.wire === 0) ep.duration = sub.uint32();
        else if (tag.field === 5 && tag.wire === 2) {
          const siteReader = sub.bytesSlice();
          const site: BangumiEpisodeSite = { site: '', id: '' };
          while (!siteReader.eof) {
            const sTag = siteReader.tag();
            if (sTag.field === 1 && sTag.wire === 2) site.site = siteReader.string();
            else if (sTag.field === 2 && sTag.wire === 2) site.id = siteReader.string();
            else siteReader.skip(sTag.wire);
          }
          if (site.site && site.id) ep.sites.push(site);
        } else if (tag.field === 6 && tag.wire === 2) {
          const ratingReader = sub.bytesSlice();
          const rating: BangumiEpisodeRating = { site: '', score: 0, count: 0 };
          while (!ratingReader.eof) {
            const rTag = ratingReader.tag();
            if (rTag.field === 1 && rTag.wire === 2) rating.site = ratingReader.string();
            else if (rTag.field === 2 && rTag.wire === 0) rating.score = ratingReader.uint32();
            else if (rTag.field === 3 && rTag.wire === 0) rating.count = ratingReader.uint32();
            else ratingReader.skip(rTag.wire);
          }
          if (rating.site) ep.rating.push(rating);
        } else if (tag.field === 7 && tag.wire === 2) ep.image = sub.string();
        else if (tag.field === 8 && tag.wire === 2) ep.title = sub.string();
        else if (tag.field === 9 && tag.wire === 2) ep.overview = sub.string();
        else sub.skip(tag.wire);
      }
      if (ep.sort > 0) episodes.push(ep);
    } else reader.skip(wire);
  }
  return episodes.sort((a, b) => a.sort - b.sort);
}

export function decodeBangumiRelated(buffer: ArrayBuffer | Uint8Array): BangumiRelatedItem[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const list: BangumiRelatedItem[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      const item: BangumiRelatedItem = {
        id: 0, title: '', name: '', episode: 0, episodesTotal: 0, status: '', date: 0, image: '', tagline: '', type: '',
      };
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 0) item.id = sub.uint32();
        else if (tag.field === 2 && tag.wire === 2) item.title = sub.string();
        else if (tag.field === 3 && tag.wire === 2) item.name = sub.string();
        else if (tag.field === 4 && tag.wire === 0) item.episode = sub.uint32();
        else if (tag.field === 5 && tag.wire === 0) item.episodesTotal = sub.uint32();
        else if (tag.field === 6 && tag.wire === 2) item.status = sub.string();
        else if (tag.field === 7 && tag.wire === 1) item.date = sub.double();
        else if (tag.field === 8 && tag.wire === 2) item.image = sub.string();
        else if (tag.field === 9 && tag.wire === 2) item.tagline = sub.string();
        else if (tag.field === 10 && tag.wire === 2) item.type = sub.string();
        else sub.skip(tag.wire);
      }
      if (item.id > 0) list.push(item);
    } else reader.skip(wire);
  }
  return list;
}

/**
 * AniCh VOD URL deobfuscation (`API.md` §5.7):
 * Strip the 4th character (index 3), normalize Base64, decode UTF-8, and allow only credential-free HTTPS URLs.
 */
export function decodeVodUrl(encoded: string): string | null {
  if (typeof encoded !== 'string' || encoded.length < 5) return null;
  const raw = (encoded.slice(0, 3) + encoded.slice(4)).trim().replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/=]+$/.test(raw) || raw.length % 4 === 1) return null;
  const padded = raw + '='.repeat((4 - (raw.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoded = utf8Decoder.decode(bytes).trim();
    const parsed = new URL(decoded);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function decodeVodList(buffer: ArrayBuffer | Uint8Array): DecodedVodLine[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const rawItems: RawVodItem[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      const item: RawVodItem = { url: '', sort: 0, type: '', caption: '' };
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 2) item.url = sub.string();
        else if (tag.field === 2 && tag.wire === 0) item.sort = sub.uint32();
        else if (tag.field === 3 && tag.wire === 2) item.type = sub.string();
        else if (tag.field === 4 && tag.wire === 2) item.caption = sub.string();
        else sub.skip(tag.wire);
      }
      rawItems.push(item);
    } else reader.skip(wire);
  }
  const lines: DecodedVodLine[] = [];
  rawItems.forEach((item, index) => {
    const url = decodeVodUrl(item.url);
    if (!url) return;
    lines.push({
      url,
      sort: item.sort || index + 1,
      type: item.type || 'vod',
      caption: item.caption.trim() || `线路 ${index + 1}`,
    });
  });
  return lines.sort((a, b) => a.sort - b.sort);
}

function sanitizeHexColor(raw: string): string {
  const trimmed = raw.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase();
  }
  return '#faf9f5';
}

export function decodeAnichDanmaku(buffer: ArrayBuffer | Uint8Array): NormalizedDanmakuItem[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const items: NormalizedDanmakuItem[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      let id = '';
      let color = '#faf9f5';
      let text = '';
      let time = 0;
      let type = 1;
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 2) id = sub.string();
        else if (tag.field === 2 && tag.wire === 2) color = sanitizeHexColor(sub.string());
        else if (tag.field === 4 && tag.wire === 2) text = sub.string().trim();
        else if (tag.field === 6 && tag.wire === 1) time = sub.double();
        else if (tag.field === 7 && tag.wire === 0) type = sub.uint32();
        else sub.skip(tag.wire);
      }
      if (text && Number.isFinite(time) && time >= 0) {
        items.push({
          id: id || `anich-${items.length}`,
          time: Math.round(time * 1000) / 1000,
          text: text.slice(0, 200),
          color,
          mode: type === 2 ? 'top' : type === 3 ? 'bottom' : 'scroll',
        });
      }
    } else reader.skip(wire);
  }
  return items;
}

export function decodeBilibiliDanmaku(buffer: ArrayBuffer | Uint8Array): NormalizedDanmakuItem[] {
  const reader = new ProtoReader(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  const items: NormalizedDanmakuItem[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 1 && wire === 2) {
      const sub = reader.bytesSlice();
      let id = 0;
      let idStr = '';
      let progress = 0;
      let mode = 1;
      let color = 0xffffff;
      let content = '';
      while (!sub.eof) {
        const tag = sub.tag();
        if (tag.field === 1 && tag.wire === 0) id = sub.uint32();
        else if (tag.field === 2 && tag.wire === 0) progress = sub.int32();
        else if (tag.field === 3 && tag.wire === 0) mode = sub.int32();
        else if (tag.field === 5 && tag.wire === 0) color = sub.uint32();
        else if (tag.field === 7 && tag.wire === 2) content = sub.string().trim();
        else if (tag.field === 12 && tag.wire === 2) idStr = sub.string();
        else sub.skip(tag.wire);
      }
      if (content && progress >= 0) {
        items.push({
          id: `bili-${idStr || id || items.length}`,
          time: Math.round(progress) / 1000,
          text: content.slice(0, 200),
          color: `#${(color & 0xffffff).toString(16).padStart(6, '0')}`,
          mode: mode === 5 ? 'top' : mode === 4 ? 'bottom' : 'scroll',
        });
      }
    } else reader.skip(wire);
  }
  return items;
}

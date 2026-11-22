import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ProtobufError, decodeAnichDanmaku, decodeBangumiEpisodes, decodeBangumiLatest,
  decodeBangumiList, decodeBangumiRelated, decodeBilibiliDanmaku, decodeVodList, decodeVodUrl,
} from '../worker/protobuf.ts';
import { handleAnimeRequest } from '../worker/anime.ts';
import { buildAnimeMediaMeta, selectPlayableVodLines } from '../src/anime.ts';
import { parseMessage } from '../worker/state.ts';

// Minimal Protobuf wire encoder matching Sle2p/AniCh .pbjson.dart descriptors.
function encodeVarint(value: number | bigint): number[] {
  let n = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (n < 0n) n = BigInt.asUintN(64, n);
  const out: number[] = [];
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) byte |= 0x80;
    out.push(byte);
  } while (n > 0n);
  return out;
}

function tag(field: number, wireType: number): number[] {
  return encodeVarint((field << 3) | wireType);
}

function varintField(field: number, value: number | bigint): number[] {
  return [...tag(field, 0), ...encodeVarint(value)];
}

function doubleField(field: number, value: number): number[] {
  const buf = new ArrayBuffer(8);
  new DataView(buf).setFloat64(0, value, true);
  return [...tag(field, 1), ...new Uint8Array(buf)];
}

function stringField(field: number, text: string): number[] {
  const bytes = new TextEncoder().encode(text);
  return [...tag(field, 2), ...encodeVarint(bytes.byteLength), ...bytes];
}

function messageField(field: number, inner: number[]): number[] {
  return [...tag(field, 2), ...encodeVarint(inner.length), ...inner];
}

function obfuscateVodUrl(plainUrl: string): string {
  const b64 = Buffer.from(plainUrl, 'utf8').toString('base64').replace(/=+$/, '');
  return `${b64.slice(0, 3)}X${b64.slice(3)}`;
}

test('decodeVodUrl deobfuscates AniCh base64 HTTPS URLs and rejects invalid/non-HTTPS inputs', () => {
  const target = 'https://cdn.example.com/anime/frieren-ep01.m3u8?token=abc';
  const encoded = obfuscateVodUrl(target);
  assert.notEqual(encoded, target);
  assert.equal(decodeVodUrl(encoded), target);
  assert.equal(decodeVodUrl(obfuscateVodUrl('http://insecure.example.com/ep1.mp4')), null);
  assert.equal(decodeVodUrl(''), null);
});

test('Protobuf decoders parse Bangumi latest, list, episodes, related, VOD, and danmaku payloads', () => {
  const latestPayload = new Uint8Array([
    ...messageField(1, [
      ...varintField(1, 1),
      ...varintField(2, 1024),
      ...varintField(3, 28),
      ...doubleField(4, 1711100000),
      ...varintField(5, 1440),
      ...stringField(6, 'https://img.example.com/frieren.jpg'),
      ...stringField(7, '下次再见的时候会很难为情吧'),
      ...stringField(8, '葬送的芙莉莲'),
    ]),
  ]);
  assert.deepEqual(decodeBangumiLatest(latestPayload), [{
    status: true,
    id: 1024,
    ep: 28,
    airdate: 1711100000,
    duration: 1440,
    image: 'https://img.example.com/frieren.jpg',
    title: '下次再见的时候会很难为情吧',
    name: '葬送的芙莉莲',
  }]);

  const listPayload = new Uint8Array([
    ...messageField(1, [
      ...varintField(1, 2048),
      ...stringField(2, '排球少年'),
      ...varintField(3, 25),
      ...varintField(4, 25),
      ...stringField(5, '已完结'),
      ...doubleField(6, 1578614400),
      ...stringField(7, 'https://img.example.com/haikyu.jpg'),
      ...stringField(8, '热血 / 运动'),
    ]),
    ...varintField(2, 0),
    ...varintField(3, 20),
  ]);
  const list = decodeBangumiList(listPayload);
  assert.equal(list.prev, 0);
  assert.equal(list.next, 20);
  assert.equal(list.data[0].id, 2048);
  assert.equal(list.data[0].tagline, '热血 / 运动');

  const episodesPayload = new Uint8Array([
    ...messageField(1, [
      ...varintField(1, 1),
      ...varintField(2, 1),
      ...doubleField(3, 1696000000),
      ...varintField(4, 1440),
      ...messageField(5, [
        ...stringField(1, 'bili'),
        ...stringField(2, '987654321'),
      ]),
      ...messageField(5, [
        ...stringField(1, 'qq'),
        ...stringField(2, 'u0045vid'),
      ]),
      ...stringField(8, '冒险的终点'),
    ]),
  ]);
  const episodes = decodeBangumiEpisodes(episodesPayload);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].sort, 1);
  assert.equal(episodes[0].title, '冒险的终点');
  assert.deepEqual(episodes[0].sites, [
    { site: 'bili', id: '987654321' },
    { site: 'qq', id: 'u0045vid' },
  ]);

  const relatedPayload = new Uint8Array([
    ...messageField(1, [
      ...varintField(1, 3001),
      ...stringField(2, '葬送的芙莉莲 第二季'),
      ...stringField(10, '续集'),
    ]),
  ]);
  assert.equal(decodeBangumiRelated(relatedPayload)[0].type, '续集');

  const vodPayload = new Uint8Array([
    ...messageField(1, [
      ...stringField(1, obfuscateVodUrl('https://vod.example.com/ep1/index.m3u8')),
      ...varintField(2, 1),
      ...stringField(3, 'hls'),
      ...stringField(4, '高清 HLS'),
    ]),
  ]);
  const vodLines = decodeVodList(vodPayload);
  assert.equal(vodLines[0].url, 'https://vod.example.com/ep1/index.m3u8');
  assert.equal(vodLines[0].type, 'hls');
  assert.equal(vodLines[0].caption, '高清 HLS');

  const anichDmPayload = new Uint8Array([
    ...messageField(1, [
      ...stringField(1, 'dm-77'),
      ...stringField(2, '#FFAA33'),
      ...stringField(4, '前方高能'),
      ...doubleField(6, 12.5),
      ...varintField(7, 2),
    ]),
  ]);
  const anichDm = decodeAnichDanmaku(anichDmPayload);
  assert.deepEqual(anichDm, [{
    id: 'dm-77',
    time: 12.5,
    text: '前方高能',
    color: '#ffaa33',
    mode: 'top',
  }]);

  const biliDmPayload = new Uint8Array([
    ...messageField(1, [
      ...varintField(1, 999),
      ...varintField(2, 24000),
      ...varintField(3, 4),
      ...varintField(5, 0x66ccff),
      ...stringField(7, '干杯！'),
    ]),
  ]);
  const biliDm = decodeBilibiliDanmaku(biliDmPayload);
  assert.deepEqual(biliDm, [{
    id: 'bili-999',
    time: 24,
    text: '干杯！',
    color: '#66ccff',
    mode: 'bottom',
  }]);

  // Truncated length-delimited payload throws ProtobufError cleanly.
  assert.throws(() => decodeBangumiLatest(new Uint8Array([0x0a, 0x10, 0x01])), ProtobufError);
});

test('handleAnimeRequest fails over across mirrors and merges AniCh, Bilibili, and QQ timeline danmaku', async () => {
  const originalFetch = globalThis.fetch;
  const seenRequests: { url: string; ua: string | null }[] = [];

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    seenRequests.push({ url: url.toString(), ua: headers.get('User-Agent') });

    if (url.origin === 'https://dead-mirror.test') {
      return Response.json({ error: true, message: 'unauthorized' }, { status: 200 });
    }

    if (url.origin === 'https://good-mirror.test') {
      if (url.pathname === '/bangumi/detail/42') {
        return Response.json({
          id: 42,
          title: '迷宫饭',
          image: 'https://img.example.com/dunmeshi.jpg',
          genres: ['奇幻', '美食'],
          rating: [{ site: 'bangumi', score: 8.6 }],
          overview: '边吃魔物边探索迷宫。',
          episode: 24,
          episodes_total: 24,
          status: '全 24 话',
        });
      }
      if (url.pathname === '/bangumi/episodes/42') {
        return new Response(new Uint8Array(messageField(1, [
          ...varintField(1, 1),
          ...varintField(2, 1),
          ...messageField(5, [
            ...stringField(1, 'bili'),
            ...stringField(2, '112233'),
          ]),
          ...messageField(5, [
            ...stringField(1, 'qq'),
            ...stringField(2, 'qqvid01'),
          ]),
          ...stringField(8, '水煮大蝎子与走路菇'),
        ])));
      }
      if (url.pathname === '/bangumi/related/42') {
        return new Response('upstream 500', { status: 500 });
      }
      if (url.pathname === '/vod/42/1') {
        return new Response(new Uint8Array(messageField(1, [
          ...stringField(1, obfuscateVodUrl('https://stream.example.com/dunmeshi-01.mp4')),
          ...varintField(2, 1),
          ...stringField(3, 'mp4'),
          ...stringField(4, '极速直连'),
        ])));
      }
      if (url.pathname === '/danmaku') {
        return new Response(new Uint8Array(messageField(1, [
          ...stringField(1, 'a1'),
          ...stringField(2, '#ffffff'),
          ...stringField(4, '开饭啦！'),
          ...doubleField(6, 8.0),
          ...varintField(7, 1),
        ])));
      }
    }

    if (url.origin === 'https://bili-dm.test') {
      return new Response(new Uint8Array(messageField(1, [
        ...varintField(1, 2),
        ...varintField(2, 3200),
        ...varintField(3, 1),
        ...varintField(5, 0xff9900),
        ...stringField(7, 'B站同步弹幕'),
      ])));
    }

    if (url.origin === 'https://qq-dm.test') {
      return Response.json({
        barrage_list: [
          { id: 'q1', content: '腾讯时间轴弹幕', time_offset: '5400', rick_type: 1 },
        ],
      });
    }

    return new Response('not found', { status: 404 });
  };

  try {
    const env = {
      ANICH_API_BASE: 'https://dead-mirror.test, https://good-mirror.test',
      ANICH_USER_AGENT: 'cx.xs.open Android 1.0.0',
      ANICH_BILI_DANMAKU_BASE: 'https://bili-dm.test',
      ANICH_QQ_DANMAKU_BASE: 'https://qq-dm.test',
    };

    const detailRes = await handleAnimeRequest(new Request('https://watch.test/api/anime/42'), env);
    assert.equal(detailRes.status, 200);
    const detailData = await detailRes.json() as any;
    assert.equal(detailData.detail.title, '迷宫饭');
    assert.equal(detailData.episodes.length, 1);
    assert.equal(detailData.episodes[0].bili, '112233');
    assert.equal(detailData.episodes[0].qq, 'qqvid01');
    assert.deepEqual(detailData.related, []);
    assert.ok(seenRequests.some(req => req.url.startsWith('https://dead-mirror.test/') && req.ua === 'cx.xs.open Android 1.0.0'));

    const vodRes = await handleAnimeRequest(new Request('https://watch.test/api/anime/42/episodes/1/vod'), env);
    assert.equal(vodRes.status, 200);
    const vodData = await vodRes.json() as any;
    assert.equal(vodData.lines[0].url, 'https://stream.example.com/dunmeshi-01.mp4');

    const dmRes = await handleAnimeRequest(
      new Request('https://watch.test/api/anime/42/episodes/1/danmaku?biliCid=112233&qqVid=qqvid01'),
      env,
    );
    assert.equal(dmRes.status, 200);
    const dmData = await dmRes.json() as any;
    assert.deepEqual(dmData.sources, { anich: 1, bili: 1, qq: 1 });
    assert.deepEqual(dmData.items.map((item: any) => item.text), [
      'B站同步弹幕',
      '腾讯时间轴弹幕',
      '开饭啦！',
    ]);

    const methodDenied = await handleAnimeRequest(new Request('https://watch.test/api/anime/latest', { method: 'POST' }), env);
    assert.equal(methodDenied.status, 405);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selectPlayableVodLines prioritizes direct HTTPS streams, and parseMessage validates anime metadata', () => {
  const sorted = selectPlayableVodLines([
    { sort: 1, type: 'mp4', caption: 'HTTP', url: 'http://insecure.example.com/a.mp4' },
    { sort: 2, type: 'parse', caption: '嗅探线路', url: 'https://parse.example.com/watch' },
    { sort: 3, type: 'hls', caption: 'HLS 线路', url: 'https://cdn.example.com/ep1.M3U8' },
    { sort: 4, type: 'mp4', caption: 'MP4 直连', url: 'https://cdn.example.com/ep1.mp4' },
  ]);
  assert.deepEqual(sorted.map(line => line.caption), ['MP4 直连', 'HLS 线路', '嗅探线路']);

  const meta = buildAnimeMediaMeta(
    { id: 42, title: '迷宫饭', episodesTotal: 24 },
    { episode: 3, title: '活动盔甲', bili: '123456', biliHmt: '', qq: 'https://v.qq.com/x/cover/abc/vid99' },
    'MP4 直连',
  );
  assert.deepEqual(meta, {
    bangumiId: 42,
    bangumiTitle: '迷宫饭',
    episode: 3,
    episodeTitle: '活动盔甲',
    episodesTotal: 24,
    lineCaption: 'MP4 直连',
    biliCid: '123456',
    qqVid: 'vid99',
  });

  const parsed = parseMessage(JSON.stringify({
    type: 'media',
    kind: 'video',
    url: 'https://cdn.example.com/ep1.mp4',
    title: '迷宫饭 第 3 话',
    anime: meta,
  }));
  assert.equal(parsed.type, 'media');
  assert.deepEqual(parsed.anime, meta);

  assert.throws(() => parseMessage(JSON.stringify({
    type: 'media',
    kind: 'web',
    url: 'https://cdn.example.com/page',
    title: 'Web with anime meta',
    anime: meta,
  })));
});

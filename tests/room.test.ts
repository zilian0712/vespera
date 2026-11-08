import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_POSITION, appendChat, applyControl, consumeRateLimit, currentPlayback,
  isAllowedOrigin, parseMessage, reconcilePlayback,
  type Member, type RoomState,
} from '../worker/state.ts';

function room(): RoomState {
  return {
    roomId: 'room', token: 'token', expiresAt: 86_400_000,
    media: { url: 'https://example.com/movie.mp4', kind: 'video', title: 'Movie' },
    playback: { paused: true, position: 10, rate: 1, updatedAt: 1000, revision: 0, seekRevision: 0 },
    userPaused: true, waitTogether: false, chat: [],
  };
}

const ready: Member = { clientId: 'a', name: 'A', ready: true, buffering: false };
const buffering: Member = { clientId: 'b', name: 'B', ready: true, buffering: true };

test('playing position is projected using server elapsed time without mutating authority', () => {
  const state = room();
  state.playback.paused = false;
  state.playback.rate = 2;
  const projected = currentPlayback(state.playback, 3500);
  assert.equal(projected.position, 15);
  assert.equal(projected.updatedAt, 3500);
  assert.equal(state.playback.position, 10);
  assert.equal(state.playback.updatedAt, 1000);
  assert.equal(projected.revision, 0);
  assert.equal(projected.seekRevision, 0);
  assert.equal(currentPlayback(state.playback, 0).position, 10);
});

test('paused position stays stable and projection is bounded', () => {
  const state = room();
  assert.equal(currentPlayback(state.playback, 5000).position, 10);
  state.playback.paused = false;
  assert.equal(currentPlayback(state.playback, Number.MAX_SAFE_INTEGER).position, MAX_POSITION);
});

test('controls increment revision while only explicit seeks increment seekRevision', () => {
  const state = room();
  applyControl(state, { type: 'control', action: 'play' }, [ready], 1000);
  assert.equal(state.playback.revision, 1);
  assert.equal(state.playback.seekRevision, 0);
  applyControl(state, { type: 'control', action: 'rate', rate: 2 }, [ready], 3000);
  assert.equal(state.playback.position, 12);
  assert.equal(state.playback.rate, 2);
  assert.equal(state.playback.revision, 2);
  assert.equal(state.playback.seekRevision, 0);
  applyControl(state, { type: 'control', action: 'seek', position: 120 }, [ready], 4000);
  assert.equal(currentPlayback(state.playback, 5000).position, 122);
  assert.equal(state.playback.revision, 3);
  assert.equal(state.playback.seekRevision, 1);
  applyControl(state, { type: 'control', action: 'pause' }, [ready], 5000);
  assert.equal(state.playback.position, 122);
  assert.equal(state.playback.paused, true);
  assert.equal(state.userPaused, true);
  assert.equal(state.playback.revision, 4);
  assert.equal(state.playback.seekRevision, 1);
  applyControl(state, { type: 'control', action: 'rate', rate: 0.5 }, [ready], 6000);
  assert.equal(state.playback.revision, 5);
  assert.equal(state.playback.seekRevision, 1);
  applyControl(state, { type: 'control', action: 'play' }, [ready], 7000);
  assert.equal(state.playback.revision, 6);
  assert.equal(state.playback.seekRevision, 1);
});

test('waitTogether pauses and resumes without changing the seek marker', () => {
  const state = room();
  state.waitTogether = true;
  applyControl(state, { type: 'control', action: 'seek', position: 10 }, [ready], 1000);
  applyControl(state, { type: 'control', action: 'play' }, [ready], 1000);
  assert.equal(state.playback.revision, 2);
  assert.equal(state.playback.seekRevision, 1);
  assert.equal(reconcilePlayback(state, [ready, buffering], 4000), true);
  assert.equal(state.playback.position, 13);
  assert.equal(state.playback.paused, true);
  assert.equal(state.userPaused, false);
  assert.equal(state.playback.revision, 3);
  assert.equal(state.playback.seekRevision, 1);
  assert.equal(reconcilePlayback(state, [ready, { ...buffering, buffering: false, ready: false }], 5000), false);
  assert.equal(state.playback.revision, 3);
  assert.equal(state.playback.seekRevision, 1);
  assert.equal(reconcilePlayback(state, [ready, { ...buffering, buffering: false }], 6000), true);
  assert.equal(state.playback.revision, 4);
  assert.equal(state.playback.seekRevision, 1);
  const projected = currentPlayback(state.playback, 8000);
  assert.equal(projected.position, 15);
  assert.equal(projected.seekRevision, 1);
});

test('explicit pause during buffering prevents auto-resume', () => {
  const state = room();
  state.waitTogether = true;
  applyControl(state, { type: 'control', action: 'play' }, [ready, buffering], 2000);
  assert.equal(state.playback.paused, true);
  assert.equal(state.userPaused, false);
  applyControl(state, { type: 'control', action: 'pause' }, [ready, buffering], 3000);
  assert.equal(reconcilePlayback(state, [ready], 5000), false);
  assert.equal(state.playback.paused, true);
  assert.equal(state.userPaused, true);
});

test('disabling waitTogether or removing buffering peer resumes pending play', () => {
  const state = room();
  state.waitTogether = true;
  applyControl(state, { type: 'control', action: 'play' }, [ready, buffering], 1000);
  state.waitTogether = false;
  assert.equal(reconcilePlayback(state, [ready, buffering], 2000), true);
  state.waitTogether = true;
  assert.equal(reconcilePlayback(state, [ready, buffering], 3000), true);
  assert.equal(reconcilePlayback(state, [ready], 4000), true);
});

test('controls require media and no media cannot resume', () => {
  const state = room();
  state.media = null;
  state.userPaused = false;
  assert.throws(() => applyControl(state, { type: 'control', action: 'play' }, [], 2000), /选择媒体/);
  state.playback.paused = false;
  assert.equal(reconcilePlayback(state, [], 2000), true);
  assert.equal(state.playback.paused, true);
});

test('messages validate numeric boundaries and required boolean fields', () => {
  for (const raw of [
    'null', '[]', '{', '{}', '{"type":"syncing"}',
    '{"type":"control","action":"seek","position":-1}',
    '{"type":"control","action":"seek","position":604801}',
    '{"type":"control","action":"rate","rate":0}',
    '{"type":"control","action":"rate","rate":5}',
    '{"type":"control","action":"seek","position":"1"}',
    '{"type":"control","action":"seek","position":1e999}',
    '{"type":"status","ready":true}',
    '{"type":"settings","waitTogether":"true"}',
    '{"type":"ping","clientTime":-1}',
  ]) assert.throws(() => parseMessage(raw), raw);
  assert.deepEqual(parseMessage('{"type":"control","action":"rate","rate":0.25}'), { type: 'control', action: 'rate', rate: 0.25 });
  assert.deepEqual(parseMessage('{"type":"control","action":"seek","position":604800}'), { type: 'control', action: 'seek', position: 604800 });
});

test('media requires HTTPS and forbids embedded credentials', () => {
  for (const url of ['http://example.com', 'javascript:alert(1)', 'https://user:pass@example.com/', 'bad']) {
    assert.throws(() => parseMessage(JSON.stringify({ type: 'media', url, kind: 'video', title: 'movie' })));
  }
  assert.throws(() => parseMessage(JSON.stringify({ type: 'media', url: 'https://example.com', kind: 'audio', title: 'movie' })));
  assert.deepEqual(parseMessage(JSON.stringify({ type: 'media', url: 'https://example.com', kind: 'web', title: ' Page ' })), {
    type: 'media', url: 'https://example.com/', kind: 'web', title: 'Page',
  });
});

test('chat trims text, rejects empty or oversized text, and remains plain data', () => {
  assert.deepEqual(parseMessage('{"type":"chat","text":" hello "}'), { type: 'chat', text: 'hello' });
  for (const text of ['', '  ', 'x'.repeat(501), '\u0000']) {
    assert.throws(() => parseMessage(JSON.stringify({ type: 'chat', text })));
  }
  assert.equal((parseMessage('{"type":"chat","text":"<img src=x>"}') as { text: string }).text, '<img src=x>');
});

test('chat retains the most recent 50 messages in order', () => {
  let messages: RoomState['chat'] = [];
  for (let i = 0; i < 60; i++) messages = appendChat(messages, { id: String(i), text: String(i), name: 'A', createdAt: i, videoTime: i });
  assert.equal(messages.length, 50);
  assert.equal(messages[0].id, '10');
  assert.equal(messages[49].id, '59');
});

test('rate limiter permits 60 messages per 10 seconds and resets at boundary', () => {
  const window = { start: 1000, count: 0 };
  for (let i = 0; i < 60; i++) assert.equal(consumeRateLimit(window, 1000 + i), true);
  assert.equal(consumeRateLimit(window, 10999), false);
  assert.equal(consumeRateLimit(window, 11000), true);
  assert.equal(window.count, 1);
});

test('seek preserves milliseconds and play/pause positions cannot override authority', () => {
  const state = room();
  const seek = parseMessage('{"type":"control","action":"seek","position":12.345}');
  assert.deepEqual(seek, { type: 'control', action: 'seek', position: 12.345 });
  applyControl(state, seek as Extract<ReturnType<typeof parseMessage>, { type: 'control' }>, [ready], 1000);
  assert.equal(state.playback.position, 12.345);
  assert.equal(state.playback.seekRevision, 1);
  applyControl(state, { type: 'control', action: 'seek', position: 12.345 }, [ready], 1000);
  assert.equal(state.playback.position, 12.345);
  assert.equal(state.playback.seekRevision, 2);
  const play = parseMessage('{"type":"control","action":"play","position":999}');
  assert.deepEqual(play, { type: 'control', action: 'play' });
  applyControl(state, play as Extract<ReturnType<typeof parseMessage>, { type: 'control' }>, [ready], 2000);
  const pause = parseMessage('{"type":"control","action":"pause","position":999}');
  applyControl(state, pause as Extract<ReturnType<typeof parseMessage>, { type: 'control' }>, [ready], 3000);
  assert.equal(state.playback.position, 13.345);
  assert.equal(state.playback.revision, 4);
  assert.equal(state.playback.seekRevision, 2);
});

test('legacy playback keeps its missing marker until an explicit seek', () => {
  const state = room();
  delete state.playback.seekRevision;
  assert.equal('seekRevision' in currentPlayback(state.playback, 2000), false);
  state.waitTogether = true;
  applyControl(state, { type: 'control', action: 'play' }, [ready], 1000);
  applyControl(state, { type: 'control', action: 'rate', rate: 2 }, [ready], 2000);
  assert.equal(reconcilePlayback(state, [ready, buffering], 3000), true);
  assert.equal(reconcilePlayback(state, [ready], 4000), true);
  applyControl(state, { type: 'control', action: 'pause' }, [ready], 5000);
  assert.equal(state.playback.revision, 5);
  assert.equal('seekRevision' in state.playback, false);
  applyControl(state, { type: 'control', action: 'seek', position: 123.456 }, [ready], 6000);
  assert.equal(state.playback.position, 123.456);
  assert.equal(state.playback.seekRevision, 1);
  applyControl(state, { type: 'control', action: 'seek', position: 123.456 }, [ready], 7000);
  assert.equal(state.playback.position, 123.456);
  assert.equal(state.playback.revision, 7);
  assert.equal(state.playback.seekRevision, 2);
});

test('telemetry validates every field and strips client-supplied identity and receipt time', () => {
  const valid = { type: 'telemetry', position: 10.123, paused: false, rate: 1.05, revision: 3, measuredAt: 1_800_000_000_123 };
  assert.deepEqual(parseMessage(JSON.stringify({ ...valid, clientId: 'forged', receivedAt: 1 })), valid);
  for (const override of [
    { position: -1 }, { position: MAX_POSITION + 1 }, { position: '10' }, { position: null },
    { paused: 'false' }, { paused: null }, { rate: 0 }, { rate: 9 }, { rate: '1' },
    { revision: -1 }, { revision: 0.1 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { measuredAt: -1 }, { measuredAt: '123' }, { measuredAt: null },
  ]) assert.throws(() => parseMessage(JSON.stringify({ ...valid, ...override })));
  for (const field of ['position', 'paused', 'rate', 'revision', 'measuredAt']) {
    const incomplete: Record<string, unknown> = { ...valid };
    delete incomplete[field];
    assert.throws(() => parseMessage(JSON.stringify(incomplete)));
  }
  assert.throws(() => parseMessage('{"type":"telemetry","position":1e999,"paused":false,"rate":1,"revision":0,"measuredAt":0}'));
  assert.deepEqual(parseMessage(JSON.stringify({ ...valid, rate: 4.2 })), { ...valid, rate: 4.2 });
  assert.deepEqual(parseMessage(JSON.stringify({ ...valid, rate: 0.2375 })), { ...valid, rate: 0.2375 });
});

test('origin is exact same origin or one explicitly configured frontend origin', () => {
  const url = 'https://watch.example/api/rooms';
  assert.equal(isAllowedOrigin('https://watch.example', url), true);
  assert.equal(isAllowedOrigin('https://frontend.vercel.app', url, 'https://frontend.vercel.app'), true);
  assert.equal(isAllowedOrigin('https://frontend.vercel.app.evil.test', url, 'https://frontend.vercel.app'), false);
  assert.equal(isAllowedOrigin('https://watch.example.evil.test', url), false);
  assert.equal(isAllowedOrigin('null', url), false);
  assert.equal(isAllowedOrigin(null, url), false);
});

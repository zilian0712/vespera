import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { danmakuStorageKey, defaultDanmaku, loadDanmaku, parseDanmaku } from '../src/danmaku.ts';
import { isPictureInPicture, supportsPictureInPicture, togglePictureInPicture } from '../src/pip.ts';

const reactionModule = build({
  entryPoints: ['src/reactions.ts'], bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.webp': 'dataurl' },
}).then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));

test('danmaku preferences keep valid settings and reject invalid persisted values', () => {
  const settings = { size: 30, opacity: .45, duration: 12, area: 'full', color: '#efb49a' };
  assert.deepEqual(parseDanmaku(settings), settings);
  assert.deepEqual(parseDanmaku({ size: 0, opacity: Infinity, duration: -1, area: 'anywhere', color: 'url(https://other.test)' }), defaultDanmaku);
  assert.deepEqual(parseDanmaku(null), defaultDanmaku);
  assert.deepEqual(parseDanmaku({ size: 32, opacity: .25, duration: 14 }), { ...defaultDanmaku, size: 32, opacity: .25, duration: 14 });
});

test('danmaku preferences recover from corrupt or inaccessible browser storage', context => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let data = '{invalid';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem(key: string) { assert.equal(key, danmakuStorageKey); return data; } } });
  context.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete (globalThis as any).localStorage;
  });
  assert.deepEqual(loadDanmaku(), defaultDanmaku);
  data = JSON.stringify({ size: 28, area: 'full' });
  assert.deepEqual(loadDanmaku(), { ...defaultDanmaku, size: 28, area: 'full' });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Denied', 'SecurityError'); } });
  assert.deepEqual(loadDanmaku(), defaultDanmaku);
});

test('the twelve generated reactions round-trip only exact allowlisted markers', async () => {
  const { reactions, reactionText, findReaction } = await reactionModule;
  assert.equal(reactions.length, 12);
  assert.equal(new Set(reactions.map((reaction: any) => reaction.id)).size, 12);
  for (const reaction of reactions) {
    assert.equal(findReaction(reactionText(reaction.id)), reaction);
    assert.match(reaction.image, /^data:image\/webp;base64,/);
    assert.ok(reaction.label);
  }
  assert.equal(findReaction('[芝麻表情:unknown]'), undefined);
  assert.equal(findReaction('[芝麻表情:https://other.test/image.png]'), undefined);
  assert.equal(findReaction('前面有文字[芝麻表情:laugh]'), undefined);
});

test('standard picture-in-picture enters and exits without touching video playback', async () => {
  const requests: string[] = [];
  const page = {
    pictureInPictureEnabled: true,
    pictureInPictureElement: null as unknown,
    async exitPictureInPicture() { requests.push('exit'); page.pictureInPictureElement = null; },
  };
  const video = {
    async requestPictureInPicture() { requests.push('enter'); page.pictureInPictureElement = video; },
    play() { throw new Error('PiP must not call play'); },
    pause() { throw new Error('PiP must not call pause'); },
  };
  assert.equal(supportsPictureInPicture(video as any, page as any), true);
  await togglePictureInPicture(video as any, page as any);
  assert.equal(isPictureInPicture(video as any, page as any), true);
  await togglePictureInPicture(video as any, page as any);
  assert.deepEqual(requests, ['enter', 'exit']);
  assert.equal(isPictureInPicture(video as any, page as any), false);
});

test('Safari presentation mode uses the supported picture-in-picture API', async () => {
  const page = {};
  const video = {
    webkitPresentationMode: 'inline',
    webkitSupportsPresentationMode(mode: string) { return mode === 'picture-in-picture'; },
    webkitSetPresentationMode(mode: string) { video.webkitPresentationMode = mode; },
  };
  assert.equal(supportsPictureInPicture(video as any, page as any), true);
  await togglePictureInPicture(video as any, page as any);
  assert.equal(isPictureInPicture(video as any, page as any), true);
  await togglePictureInPicture(video as any, page as any);
  assert.equal(video.webkitPresentationMode, 'inline');
});

test('unsupported and denied picture-in-picture surface a failure', async () => {
  assert.equal(supportsPictureInPicture({} as any, {} as any), false);
  await assert.rejects(togglePictureInPicture({} as any, {} as any), /不支持画中画/);
  const failure = new DOMException('Denied', 'NotAllowedError');
  await assert.rejects(togglePictureInPicture({ requestPictureInPicture: async () => { throw failure; } } as any, { pictureInPictureEnabled: true } as any), error => error === failure);
});

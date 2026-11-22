import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as React from 'react';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

(globalThis as any).__appTestReact = React;
(globalThis as any).__appTestJsx = ReactJsxRuntime;

async function buildAppForTest(mockRoomReturn: Record<string, unknown>) {
  (globalThis as any).__mockUseRoom = () => mockRoomReturn;
  const out = await build({
    entryPoints: ['src/App.tsx'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.webp': 'dataurl', '.css': 'empty' },
    define: { 'import.meta.env.VITE_API_BASE': 'undefined' },
    plugins: [{
      name: 'app-ssr-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom)$/ }, args => ({ path: args.path, namespace: 'ext-react' }));
        builder.onLoad({ filter: /.*/, namespace: 'ext-react' }, args => ({
          contents: {
            react: 'const R = globalThis.__appTestReact; export const { useState, useEffect, useRef, useCallback, useMemo, useSyncExternalStore, createElement, forwardRef, Fragment } = R; export default R;',
            'react/jsx-runtime': 'export const { jsx, jsxs, Fragment } = globalThis.__appTestJsx;',
            'react-dom': 'export function flushSync(cb) { cb(); }',
          }[args.path],
        }));
        builder.onResolve({ filter: /^\.\/room$/ }, () => ({ path: './room', namespace: 'mock-room' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock-room' }, () => ({
          contents: `
            export async function createRoom() { return { roomId: 'r1', token: 't1' }; }
            export function useRoom() { return globalThis.__mockUseRoom(); }
          `,
        }));
        builder.onResolve({ filter: /^\.\/viewport$/ }, () => ({ path: './viewport', namespace: 'mock-vp' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock-vp' }, () => ({
          contents: `export function useViewport() { return { width: 1280, height: 800, top: 0, touch: false, landscape: true }; }`,
        }));
        builder.onResolve({ filter: /^\.\/useVoice$/ }, () => ({ path: './useVoice', namespace: 'mock-voice' }));
        builder.onLoad({ filter: /.*/, namespace: 'mock-voice' }, () => ({
          contents: `
            export function useVoice() {
              return {
                state: { available: false, enabled: false, mode: 'call', status: 'off', phase: 'idle', authenticated: false, friendMode: null, muted: false, holding: false, talking: false, listening: false, error: '' },
                audioBlocked: false,
                enable() {}, disable() {}, setMode() {}, startCall() {}, acceptCall() {}, rejectCall() {}, hangup() {}, toggleMute() {}, startTalk() {}, stopTalk() {}, resumeAudio() {},
              };
            }
          `,
        }));
      },
    }],
  });
  const mod = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
  return () => renderToStaticMarkup(React.createElement(mod.default));
}

test('App renders clean landing page for new visitors and opens nickname prompt automatically on invite links', async () => {
  const prevLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: () => null, setItem() {} },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '', origin: 'https://watch.test', pathname: '/', search: '', href: 'https://watch.test/' },
      configurable: true,
    });

    const renderBaseApp = await buildAppForTest({
      room: null,
      connection: '未连接',
      error: '',
      clearError() {},
      latency: null,
      clientId: 'me',
      send: () => false,
      serverNow: () => 1_800_000_000_000,
      clockReady: false,
      peerTelemetry: null,
    });

    const landingHtml = renderBaseApp();
    assert.match(landingHtml, /创建双人房间/);
    assert.doesNotMatch(landingHtml, /怎么称呼你？/, 'First-time landing view should not block hero with nickname modal');

    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#room=abcd&key=secret', origin: 'https://watch.test', pathname: '/', search: '', href: 'https://watch.test/#room=abcd&key=secret' },
      configurable: true,
    });
    const invitedHtml = renderBaseApp();
    assert.match(invitedHtml, /怎么称呼你？/);
    assert.match(invitedHtml, /进入放映室/);
  } finally {
    if (prevLocation) Object.defineProperty(globalThis, 'location', prevLocation);
    else delete (globalThis as any).location;
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else delete (globalThis as any).localStorage;
  }
});

test('App renders Bangumi episode bar and attributes own chat messages by clientId instead of display name collision', async () => {
  const prevLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

  try {
    Object.defineProperty(globalThis, 'localStorage', {
      value: { getItem: (k: string) => (k === 'zhima-name' ? '🦊阿狸' : null), setItem() {} },
      configurable: true,
    });
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#room=room123&key=tok456', origin: 'https://watch.test', pathname: '/', search: '', href: 'https://watch.test/#room=room123&key=tok456' },
      configurable: true,
    });

    const renderRoomApp = await buildAppForTest({
      room: {
        media: {
          id: 'm1',
          kind: 'video',
          url: 'https://cdn.example.com/ep3.mp4',
          title: '迷宫饭 第 3 话 · 活动盔甲',
          anime: {
            bangumiId: 42,
            bangumiTitle: '迷宫饭',
            episode: 3,
            episodesTotal: 24,
            lineCaption: '高清直连',
          },
        },
        playback: { paused: true, position: 0, rate: 1, updatedAt: 1_800_000_000_000, revision: 1, seekRevision: 0 },
        members: [
          { clientId: 'me', name: '🦊阿狸', ready: true, buffering: false },
          { clientId: 'friend', name: '🦊阿狸', ready: true, buffering: false },
        ],
        chat: [
          { id: 'c1', text: '我发的', name: '🦊阿狸', clientId: 'me', createdAt: 1_800_000_000_000, videoTime: 5 },
          { id: 'c2', text: '同名朋友发的', name: '🦊阿狸', clientId: 'friend', createdAt: 1_800_000_001_000, videoTime: 6 },
        ],
        waitTogether: true,
        userPaused: true,
      },
      connection: '已连接',
      error: '测试提示',
      clearError() {},
      latency: 18,
      clientId: 'me',
      send: () => true,
      serverNow: () => 1_800_000_002_000,
      clockReady: true,
      peerTelemetry: null,
    });

    const html = renderRoomApp();
    assert.match(html, /番剧同看/);
    assert.match(html, /第 3 \/ 24 话/);
    assert.match(html, /线路：高清直连/);
    assert.match(html, /选集 \/ 换线路/);
    const ownMatches = html.match(/class="message own"/g) || [];
    assert.equal(ownMatches.length, 1);
  } finally {
    if (prevLocation) Object.defineProperty(globalThis, 'location', prevLocation);
    else delete (globalThis as any).location;
    if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
    else delete (globalThis as any).localStorage;
  }
});

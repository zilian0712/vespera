import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import type { ComponentProps } from 'react';
import type Player from '../src/Player.tsx';

type PlayerProps = ComponentProps<typeof Player>;
type Element = { type: unknown; props: Record<string, any> };
type Write = { at: number; value: number };

async function playerHarness(initial: { readyState?: number; playback?: Partial<NonNullable<PlayerProps['playback']>>; touch?: boolean; landscape?: boolean } = {}) {
  const state: unknown[] = [];
  const refs: { current: any }[] = [];
  const callbacks: { dependencies: unknown[]; callback: Function }[] = [];
  const effects: { dependencies: unknown[]; cleanup?: () => void }[] = [];
  const scheduled: (() => void)[] = [];
  let stateIndex = 0;
  let refIndex = 0;
  let callbackIndex = 0;
  let effectIndex = 0;
  let dirty = false;
  let mounted = false;
  let local = 0;
  let nextTimer = 0;
  const epoch = 1_800_000_000_000;
  const timers = new Map<number, { due: number; delay: number; repeat: boolean; callback: () => void }>();
  const messages: { at: number; data: any }[] = [];
  const dependenciesChanged = (previous: unknown[], next: unknown[]) => previous.length !== next.length || next.some((value, index) => !Object.is(value, previous[index]));
  const hooks = {
    useState(initialValue: unknown) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initialValue === 'function' ? initialValue() : initialValue;
      return [state[index], (value: any) => {
        const next = typeof value === 'function' ? value(state[index]) : value;
        if (!Object.is(state[index], next)) { state[index] = next; dirty = true; }
      }];
    },
    useRef(initialValue: unknown) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useCallback(callback: Function, dependencies: unknown[]) {
      const index = callbackIndex++;
      if (!callbacks[index] || dependenciesChanged(callbacks[index].dependencies, dependencies)) callbacks[index] = { dependencies, callback };
      return callbacks[index].callback;
    },
    useEffect(callback: () => (() => void) | undefined, dependencies: unknown[]) {
      const index = effectIndex++;
      const previous = effects[index];
      if (!previous || dependenciesChanged(previous.dependencies, dependencies)) {
        scheduled.push(() => {
          previous?.cleanup?.();
          effects[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };

  let position = 10;
  let rate = 1;
  let progressionRate: number | undefined;
  let pauseEventDelay = 0;
  let videoProps: Record<string, any> = {};
  const emit = (name: string) => videoProps[name]?.({ currentTarget: video, target: video });
  const video = new class extends EventTarget {
    readyState = initial.readyState ?? 4;
    paused = true;
    seeking = false;
    ended = false;
    error = null;
    duration = 3600;
    src = '';
    volume = 1;
    muted = false;
    buffered = { length: 0, end: () => 0 };
    seeks: Write[] = [];
    rates: Write[] = [];
    plays: number[] = [];
    pauses: number[] = [];
    loads: number[] = [];
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
    webkitDisplayingFullscreen = false;
    webkitPresentationMode = 'inline';
    webkitSupportsPresentationMode?: (mode: string) => boolean;
    webkitSetPresentationMode?: (mode: string) => void;
    requestPictureInPicture?: () => Promise<void>;
    get currentTime() { return position; }
    set currentTime(value: number) { this.seeks.push({ at: local, value }); position = value; }
    get playbackRate() { return rate; }
    set playbackRate(value: number) { this.rates.push({ at: local, value }); rate = value; }
    play() {
      this.plays.push(local);
      if (this.readyState >= 3 && this.paused) {
        this.paused = false;
        emit('onPlay');
        emit('onPlaying');
      }
      return Promise.resolve();
    }
    pause() {
      this.pauses.push(local);
      if (!this.paused) {
        this.paused = true;
        if (pauseEventDelay) timer(() => emit('onPause'), pauseEventDelay, false);
        else emit('onPause');
      }
    }
    load() { this.loads.push(local); }
    removeAttribute(name: string) { if (name === 'src') this.src = ''; }
    canPlayType() { return ''; }
  };
  const root: {
    requestFullscreen?: (options?: { navigationUI?: string }) => Promise<void>;
    webkitRequestFullscreen?: () => Promise<void> | void;
  } = {};
  const input = { focus() {}, blur() {} };
  let tree: Element;
  let elements: Element[] = [];
  const attach = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(attach); return; }
    if (!node || typeof node !== 'object' || !('props' in node)) return;
    const element = node as Element;
    elements.push(element);
    if (element.type === 'video') videoProps = element.props;
    if (element.props.ref) {
      const target = element.type === 'video' ? video : element.type === 'input' ? input : root;
      if (typeof element.props.ref === 'function') element.props.ref(target);
      else element.props.ref.current = target;
    }
    attach(element.props.children);
  };
  let props: PlayerProps = {
    media: { id: 'media-a', url: 'https://media.test/movie.mp4', title: 'Movie', kind: 'video' },
    playback: { paused: false, position: 10, rate: 1, updatedAt: epoch, revision: 1, seekRevision: 0, ...initial.playback },
    userPaused: false,
    serverNow: () => epoch + local,
    clockReady: true,
    peerTelemetry: null,
    send: data => { messages.push({ at: local, data }); return true; },
    messages: [],
    connected: true,
    onTyping() {},
    onSource() {},
  };
  const page = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    fullscreenElement: null as typeof root | null,
    webkitFullscreenElement: null as typeof root | null,
    fullscreenEnabled: undefined as boolean | undefined,
    pictureInPictureEnabled: false,
    pictureInPictureElement: null as typeof video | null,
    exitPictureInPicture: undefined as (() => Promise<void>) | undefined,
    exitFullscreen: undefined as (() => Promise<void>) | undefined,
    webkitExitFullscreen: undefined as (() => Promise<void> | void) | undefined,
  });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replace = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const timer = (callback: () => void, delay: number, repeat: boolean) => {
    const id = ++nextTimer;
    timers.set(id, { due: local + delay, delay, repeat, callback });
    return id;
  };
  const restoreGlobals = () => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  };
  replace('__playerTestHooks', hooks);
  replace('performance', { now: () => local });
  replace('document', page);
  replace('setTimeout', (callback: () => void, delay: number) => timer(callback, delay, false));
  replace('setInterval', (callback: () => void, delay: number) => timer(callback, delay, true));
  replace('clearTimeout', (id: number) => timers.delete(id));
  replace('clearInterval', (id: number) => timers.delete(id));

  try {
    const output = await build({
      entryPoints: ['src/Player.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic', loader: { '.webp': 'dataurl' },
      plugins: [{
        name: 'player-browser-stubs',
        setup(builder) {
          builder.onResolve({ filter: /^(react|react\/jsx-runtime|react-dom|hls\.js|lucide-react|\.\/viewport)$/ }, args => ({ path: args.path, namespace: 'test' }));
          builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({
            contents: {
              react: 'export const {useState,useRef,useCallback,useEffect}=globalThis.__playerTestHooks;',
              'react/jsx-runtime': 'export const Fragment=Symbol("Fragment"); export function jsx(type,props){return {type,props};} export const jsxs=jsx;',
              'react-dom': 'export function flushSync(callback){callback();}',
              'hls.js': 'export default class Hls { static isSupported(){return false;} }',
              'lucide-react': 'const Icon=()=>null; export {Icon as ArrowLeft,Icon as Check,Icon as ChevronDown,Icon as Film,Icon as Maximize,Icon as MessageSquare,Icon as Minimize,Icon as Pause,Icon as Play,Icon as RotateCcw,Icon as RotateCw,Icon as Send,Icon as Volume2,Icon as VolumeX,Icon as X};',
              './viewport': `export function useViewport(){return ${JSON.stringify({ touch: initial.touch ?? false, landscape: initial.landscape ?? false, height: 800, top: 0 })};}`,
            }[args.path],
          }));
        },
      }],
    });
    const { default: Player } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${crypto.randomUUID()}`);
    const render = () => {
      let passes = 0;
      do {
        assert.ok(++passes <= 25, 'Player must settle after state updates');
        dirty = false;
        stateIndex = refIndex = callbackIndex = effectIndex = 0;
        elements = [];
        tree = Player(props);
        attach(tree);
        mounted = true;
        for (const effect of scheduled.splice(0)) effect();
      } while (dirty);
    };
    const settle = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
      if (dirty && mounted) render();
    };
    const button = (label: string) => elements.filter(element => element.type === 'button' && element.props['aria-label'] === label).at(-1);
    const click = async (label: string) => {
      await settle();
      const element = button(label);
      assert.ok(element, `Player must render a button labelled ${label}`);
      await element.props.onClick();
      await settle();
    };
    const moveTo = (time: number) => {
      if (!video.paused && !video.seeking && video.readyState >= 3) position += (time - local) / 1000 * (progressionRate ?? rate);
      local = time;
    };
    const advance = async (milliseconds: number) => {
      await settle();
      const target = local + milliseconds;
      while (true) {
        const next = [...timers.entries()].filter(([, task]) => task.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, task] = next;
        moveTo(task.due);
        if (task.repeat) task.due += task.delay;
        else timers.delete(id);
        task.callback();
        await settle();
      }
      moveTo(target);
      await settle();
    };
    const clearCalls = () => {
      video.seeks.length = video.rates.length = video.plays.length = video.pauses.length = video.loads.length = 0;
      messages.length = 0;
    };
    const unmount = () => {
      mounted = false;
      for (const effect of effects.splice(0)) effect?.cleanup?.();
    };
    return {
      render, advance, video, root, page, button, click, clearCalls, messages, epoch, emit,
      get tree() { return tree; },
      get elements() { return elements; },
      now: () => local,
      setPosition: (value: number) => { position = value; },
      setProgressionRate: (value: number | undefined) => { progressionRate = value; },
      setPauseEventDelay: (milliseconds: number) => { pauseEventDelay = milliseconds; },
      updateMessages: (value: PlayerProps['messages']) => { props = { ...props, messages: value }; render(); },
      updatePlayback: (change: Partial<NonNullable<PlayerProps['playback']>>) => {
        props = { ...props, playback: { ...props.playback!, ...change } };
        render();
      },
      restore: () => { try { unmount(); } finally { restoreGlobals(); } },
    };
  } catch (error) {
    restoreGlobals();
    throw error;
  }
}

for (const offset of [-0.4, 0.4]) {
  test(`Player corrects a persistent ${offset * 1000} ms drift over a minute without repeated seeks or rate writes`, async () => {
    const harness = await playerHarness();
    try {
      harness.render();
      await harness.advance(60000);
      assert.equal(harness.video.paused, false);
      assert.equal(harness.video.plays.length, 1);
      assert.ok(Math.abs(harness.video.currentTime - 70) < 0.01, 'mock video must progress during normal playback');
      assert.equal(harness.video.seeks.length, 0);
      assert.ok(harness.video.rates.length <= 2, 'steady playback must not rewrite the same rate every 200 ms');
      harness.clearCalls();
      harness.setPosition(70 + offset);
      // Keep the decoder offset fixed even while correction changes the requested rate.
      harness.setProgressionRate(1);
      await harness.advance(60000);
      assert.equal(harness.video.seeks.length, 0, '400 ms drift must use rate correction instead of the 1.8 s seek cycle');
      assert.ok(harness.video.rates.length > 0 && harness.video.rates.length <= 3, `constant drift should settle on a rate, got ${harness.video.rates.length} writes`);
      assert.ok(harness.video.rates.every(write => offset < 0 ? write.value > 1 && write.value <= 1.05 : write.value < 1 && write.value >= 0.95));
      assert.equal(harness.video.plays.length, 0);
      assert.equal(harness.video.pauses.length, 0);
      assert.ok(Math.abs(harness.video.currentTime - (130 + offset)) < 0.01);
      harness.clearCalls();
      harness.setPosition(130);
      await harness.advance(5000);
      assert.equal(harness.video.playbackRate, 1, 'rate correction must return to the room rate after drift clears');
      assert.equal(harness.video.rates.length, 1);
      assert.equal(harness.video.seeks.length, 0);
    } finally { harness.restore(); }
  });
}

test('Player leaves an already paused video idle and applies only real pause/resume transitions', async () => {
  const harness = await playerHarness({ playback: { paused: true } });
  try {
    harness.render();
    await harness.advance(60000);
    assert.equal(harness.video.paused, true);
    assert.equal(harness.video.pauses.length, 0, 'an already paused video must not receive pause() every reconcile');
    assert.equal(harness.video.plays.length, 0);
    assert.equal(harness.video.seeks.length, 0);
    assert.ok(harness.video.rates.length <= 1);
    harness.updatePlayback({ paused: false, position: 10, revision: 2, updatedAt: harness.epoch + harness.now() });
    await harness.advance(1000);
    assert.equal(harness.video.paused, false);
    assert.equal(harness.video.plays.length, 1);
    harness.clearCalls();
    harness.updatePlayback({ paused: true, position: harness.video.currentTime, revision: 3, updatedAt: harness.epoch + harness.now() });
    await harness.advance(60000);
    assert.equal(harness.video.paused, true);
    assert.equal(harness.video.pauses.length, 1);
    assert.equal(harness.video.plays.length, 0);
  } finally { harness.restore(); }
});

test('Player blocks native unexpected pauses and does not enter a play-pause loop', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    await harness.advance(60000);
    assert.equal(harness.video.paused, false);
    harness.clearCalls();
    harness.video.paused = true;
    harness.emit('onPause');
    const blocked = harness.messages.filter(message => message.data.type === 'status' && message.data.ready === false && message.data.buffering === true);
    assert.ok(blocked.length >= 1, 'an unexpected native pause must report a blocked status');
    await harness.advance(30000);
    assert.equal(harness.video.plays.length, 0, 'a native platform pause must not trigger repeated play attempts');
    assert.equal(harness.video.rates.length, 0, 'a native platform pause must not rewrite playbackRate');
    assert.equal(harness.video.paused, true);
  } finally { harness.restore(); }
});

test('Player does not misclassify a delayed application pause after the room resumes', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    await harness.advance(60000);
    harness.clearCalls();
    harness.setPauseEventDelay(500);
    harness.updatePlayback({ paused: true, revision: 2, updatedAt: harness.epoch + harness.now(), position: harness.video.currentTime });
    await harness.advance(200);
    assert.equal(harness.video.paused, true);
    harness.updatePlayback({ paused: false, revision: 3, updatedAt: harness.epoch + harness.now(), position: harness.video.currentTime });
    await harness.advance(300);
    assert.equal(harness.video.plays.length, 1, 'the room resume must play before the delayed pause event arrives');
    await harness.advance(300);
    const blocked = harness.messages.filter(message => message.data.type === 'status' && message.data.ready === false && message.data.buffering === true);
    assert.equal(blocked.length, 0, 'a delayed application pause must not set gestureBlocked');
    harness.clearCalls();
    await harness.advance(30000);
    assert.equal(harness.video.plays.length, 0, 'the delayed application pause must not create a retry loop');
    assert.equal(harness.video.seeks.length, 0, 'a delayed application pause must not force a seek');
    assert.ok(harness.video.rates.length <= 3, 'normal drift correction must remain bounded after the delayed pause');
    assert.equal(new Set(harness.video.rates.map(write => write.value)).size, harness.video.rates.length, 'rate correction must not write the same value repeatedly');
    assert.equal(harness.video.paused, false);
  } finally { harness.restore(); }
});

test('Player does not retry play or write playbackRate while only metadata is loaded', async () => {
  const harness = await playerHarness({ readyState: 1 });
  try {
    harness.render();
    await harness.advance(60000);
    assert.equal(harness.video.paused, true);
    assert.equal(harness.video.plays.length, 0, 'readyState 1 must wait for playable data instead of periodically retrying play()');
    assert.equal(harness.video.rates.length, 0, 'loading must not repeatedly reconfigure playbackRate');
    assert.equal(harness.video.pauses.length, 0);
    harness.video.readyState = 4;
    await harness.advance(200);
    assert.equal(harness.video.paused, false);
    assert.equal(harness.video.plays.length, 1, 'playback should start on the first playable reconcile');
    await harness.advance(5000);
    harness.clearCalls();
    await harness.advance(60000);
    assert.equal(harness.video.plays.length, 0);
    assert.equal(harness.video.seeks.length, 0);
    assert.ok(harness.video.rates.length <= 2);
  } finally { harness.restore(); }
});

test('Player status heartbeats debounce transient stalls and report sustained buffering and recovery', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    await harness.advance(62600);
    harness.clearCalls();
    const statuses = () => harness.messages.filter(message => message.data.type === 'status');
    harness.video.readyState = 1;
    harness.emit('onWaiting');
    await harness.advance(1000);
    assert.equal(statuses().length, 0, 'a 3 s status heartbeat must not bypass the buffering debounce');
    harness.video.readyState = 4;
    harness.emit('onCanPlay');
    assert.equal(statuses().filter(message => !message.data.ready).length, 0);
    harness.clearCalls();
    harness.video.readyState = 1;
    harness.emit('onLoadedMetadata');
    harness.emit('onWaiting');
    await harness.advance(1199);
    assert.equal(statuses().length, 0, 'waiting events must preserve the 1.2 s grace period');
    await harness.advance(101);
    const waiting = statuses();
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0].data.ready, false);
    assert.equal(waiting[0].data.buffering, true);
    await harness.advance(1700);
    assert.equal(statuses().at(-1)!.data.ready, false, 'the next heartbeat must preserve sustained buffering');
    harness.clearCalls();
    harness.video.readyState = 4;
    harness.emit('onCanPlay');
    assert.equal(statuses().length, 1);
    assert.equal(statuses()[0].data.ready, true, 'playable data should immediately clear sustained buffering');
    assert.equal(statuses()[0].data.buffering, false);
  } finally { harness.restore(); }
});

test('Player waitTogether revisions pause and resume without forcing small-drift seeks', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    await harness.advance(60000);
    harness.clearCalls();
    harness.updatePlayback({ paused: true, position: harness.video.currentTime + 0.2, revision: 2, updatedAt: harness.epoch + harness.now() });
    await harness.advance(2000);
    assert.equal(harness.video.paused, true);
    assert.equal(harness.video.pauses.length, 1);
    assert.equal(harness.video.seeks.length, 0, 'waitTogether pause changes revision but not seekRevision');
    harness.clearCalls();
    harness.updatePlayback({ paused: false, position: harness.video.currentTime + 0.2, revision: 3, updatedAt: harness.epoch + harness.now() });
    await harness.advance(2000);
    assert.equal(harness.video.paused, false);
    assert.equal(harness.video.plays.length, 1);
    assert.equal(harness.video.pauses.length, 0);
    assert.equal(harness.video.seeks.length, 0, 'waitTogether resume must preserve continuous playback for small drift');
  } finally { harness.restore(); }
});

test('Player applies explicit small seeks once and preserves them while the video is seeking', async () => {
  const harness = await playerHarness({ playback: { paused: true } });
  try {
    harness.render();
    await harness.advance(60000);
    harness.clearCalls();
    harness.updatePlayback({ position: 10.12, revision: 2, seekRevision: 1, updatedAt: harness.epoch + harness.now() });
    await harness.advance(200);
    assert.equal(harness.video.seeks.length, 1);
    assert.ok(Math.abs(harness.video.seeks[0].value - 10.12) < 0.001, 'an explicit seek must apply even below normal drift thresholds');
    harness.clearCalls();
    harness.video.seeking = true;
    harness.updatePlayback({ position: 10.24, revision: 3, seekRevision: 2, updatedAt: harness.epoch + harness.now() });
    await harness.advance(4000);
    assert.equal(harness.video.seeks.length, 0, 'in-flight browser seek must not be overwritten');
    harness.video.seeking = false;
    await harness.advance(200);
    assert.equal(harness.video.seeks.length, 1, 'the pending seekRevision must survive reconciles while seeking');
    assert.ok(Math.abs(harness.video.seeks[0].value - 10.24) < 0.001);
    harness.clearCalls();
    harness.setPosition(10.14);
    await harness.advance(4000);
    assert.equal(harness.video.seeks.length, 0, 'an applied seekRevision must not force another small seek on later reconciles');
  } finally { harness.restore(); }
});

test('Player touch fullscreen requests the container with hidden browser UI and exits without changing playback', async () => {
  const harness = await playerHarness({ touch: true });
  try {
    const requests: unknown[] = [];
    const otherRequests: string[] = [];
    let exits = 0;
    harness.root.requestFullscreen = async options => { requests.push(options); };
    harness.root.webkitRequestFullscreen = () => { otherRequests.push('container'); };
    harness.video.webkitEnterFullscreen = () => { otherRequests.push('video'); };
    harness.page.exitFullscreen = async () => {
      exits++;
      harness.page.fullscreenElement = null;
      harness.page.dispatchEvent(new Event('fullscreenchange'));
    };
    harness.render();
    await harness.advance(0);
    harness.clearCalls();
    const position = harness.video.currentTime;
    const rate = harness.video.playbackRate;

    await harness.click('全屏');
    assert.deepEqual(requests, [{ navigationUI: 'hide' }]);
    assert.deepEqual(otherRequests, [], 'the standard container API must take priority on touch devices');
    assert.ok(harness.button('全屏'), 'native fullscreen state must wait for fullscreenchange');
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
    harness.page.fullscreenElement = harness.root;
    harness.page.dispatchEvent(new Event('fullscreenchange'));
    await harness.advance(0);
    assert.ok(harness.button('退出全屏'));
    assert.equal(harness.button('全屏'), undefined);
    assert.match(harness.tree.props.className, /\bimmersive\b/);

    await harness.click('退出全屏');
    assert.equal(exits, 1);
    assert.equal(harness.page.fullscreenElement, null);
    assert.ok(harness.button('全屏'));
    assert.equal(harness.button('退出全屏'), undefined);
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
    assert.equal(harness.video.currentTime, position);
    assert.equal(harness.video.playbackRate, rate);
    assert.equal(harness.video.paused, false);
    assert.deepEqual(harness.video.seeks, []);
    assert.deepEqual(harness.video.rates, []);
    assert.deepEqual(harness.video.plays, []);
    assert.deepEqual(harness.video.pauses, []);
    assert.deepEqual(harness.video.loads, []);
    assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), []);
  } finally { harness.restore(); }
});

test('Player automatic touch landscape immersion still requests native fullscreen when its fullscreen button is clicked', async () => {
  const harness = await playerHarness({ touch: true, landscape: true });
  try {
    const requests: unknown[] = [];
    let exits = 0;
    harness.root.requestFullscreen = async options => {
      requests.push(options);
      harness.page.fullscreenElement = harness.root;
      harness.page.dispatchEvent(new Event('fullscreenchange'));
    };
    harness.page.exitFullscreen = async () => {
      exits++;
      harness.page.fullscreenElement = null;
      harness.page.dispatchEvent(new Event('fullscreenchange'));
    };
    harness.render();
    await harness.advance(0);
    assert.match(harness.tree.props.className, /\bimmersive\b/);
    assert.ok(harness.button('全屏'));
    assert.ok(harness.button('退出沉浸模式'));
    assert.equal(harness.button('退出全屏'), undefined);

    await harness.click('全屏');
    assert.deepEqual(requests, [{ navigationUI: 'hide' }]);
    assert.equal(exits, 0, 'automatic landscape immersion must not be treated as native fullscreen');
    assert.equal(harness.page.fullscreenElement, harness.root);
    assert.ok(harness.button('退出全屏'));
    assert.equal(harness.button('全屏'), undefined);

    await harness.click('退出全屏');
    assert.equal(exits, 1);
    assert.ok(harness.button('全屏'));
    assert.equal(harness.button('退出全屏'), undefined);
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/, 'exiting must dismiss automatic landscape immersion too');
  } finally { harness.restore(); }
});

for (const mode of ['unsupported', 'rejected'] as const) {
  test(`Player explains its ${mode} fullscreen fallback and clears immersion on exit`, async () => {
    const harness = await playerHarness({ touch: true, landscape: true });
    try {
      const requests: unknown[] = [];
      let exits = 0;
      if (mode === 'rejected') harness.root.requestFullscreen = async options => {
        requests.push(options);
        throw new Error('Fullscreen denied');
      };
      harness.page.exitFullscreen = async () => { exits++; };
      harness.render();
      await harness.advance(0);

      await harness.click('全屏');
      assert.deepEqual(requests, mode === 'rejected' ? [{ navigationUI: 'hide' }] : []);
      const feedback = harness.elements.find(element => element.props.className === 'player-feedback');
      assert.equal(feedback?.props.role, 'status');
      assert.equal(feedback?.props.children, mode === 'unsupported'
        ? '当前浏览器不支持真正全屏，已进入网页沉浸模式'
        : '浏览器未允许全屏，已进入网页沉浸模式；可尝试用系统浏览器打开');
      assert.equal(harness.page.fullscreenElement, null);
      assert.match(harness.tree.props.className, /\bimmersive\b/);
      assert.ok(harness.button('退出网页沉浸模式'));
      assert.equal(harness.button('退出全屏'), undefined);
      assert.equal(harness.button('全屏'), undefined);

      await harness.click('退出网页沉浸模式');
      assert.equal(exits, 0, 'a CSS fallback must not call the native exit API');
      assert.ok(harness.button('全屏'));
      assert.equal(harness.button('退出网页沉浸模式'), undefined);
      assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
      await harness.click('全屏');
      assert.equal(requests.length, mode === 'rejected' ? 2 : 0, 'a rejected request must not leave fullscreen pending');
      assert.ok(harness.button('退出网页沉浸模式'));
      await harness.click('退出网页沉浸模式');
      assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
    } finally { harness.restore(); }
  });
}

test('Player prefers WebKit container fullscreen over iOS video fullscreen and handles WebKit exit events', async () => {
  const harness = await playerHarness({ touch: true, landscape: true });
  try {
    let standardRequests = 0;
    let containerRequests = 0;
    let containerExits = 0;
    let videoRequests = 0;
    let videoExits = 0;
    harness.page.fullscreenEnabled = false;
    harness.root.requestFullscreen = async () => { standardRequests++; };
    harness.root.webkitRequestFullscreen = () => {
      containerRequests++;
      harness.page.webkitFullscreenElement = harness.root;
      harness.page.dispatchEvent(new Event('webkitfullscreenchange'));
    };
    harness.page.webkitExitFullscreen = () => {
      containerExits++;
      harness.page.webkitFullscreenElement = null;
      harness.page.dispatchEvent(new Event('webkitfullscreenchange'));
    };
    harness.video.webkitEnterFullscreen = () => { videoRequests++; };
    harness.video.webkitExitFullscreen = () => { videoExits++; };
    harness.render();
    await harness.advance(0);

    await harness.click('全屏');
    assert.equal(standardRequests, 0, 'fullscreenEnabled=false must skip the standard API');
    assert.equal(containerRequests, 1);
    assert.equal(videoRequests, 0);
    assert.equal(harness.page.fullscreenElement, null);
    assert.equal(harness.page.webkitFullscreenElement, harness.root);
    assert.ok(harness.button('退出全屏'));
    assert.equal(harness.button('全屏'), undefined);

    await harness.click('退出全屏');
    assert.equal(containerExits, 1);
    assert.equal(videoExits, 0);
    assert.equal(harness.page.webkitFullscreenElement, null);
    assert.ok(harness.button('全屏'));
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);

    await harness.click('全屏');
    assert.equal(containerRequests, 2);
    harness.page.webkitFullscreenElement = null;
    harness.page.dispatchEvent(new Event('webkitfullscreenchange'));
    await harness.advance(0);
    assert.equal(containerExits, 1, 'a browser-driven exit must update state without calling the exit API');
    assert.ok(harness.button('全屏'));
    assert.equal(harness.button('退出全屏'), undefined);
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
  } finally { harness.restore(); }
});

test('Player iOS video fullscreen follows native begin/end events and calls the video exit API', async () => {
  const harness = await playerHarness({ touch: true, landscape: true });
  try {
    let entries = 0;
    let exits = 0;
    harness.video.webkitEnterFullscreen = () => { entries++; };
    harness.video.webkitExitFullscreen = () => { exits++; };
    harness.render();
    await harness.advance(0);

    await harness.click('全屏');
    assert.equal(entries, 1);
    assert.ok(harness.button('全屏'), 'the enter call alone must not replace the native begin event');
    harness.video.webkitDisplayingFullscreen = true;
    harness.video.dispatchEvent(new Event('webkitbeginfullscreen'));
    await harness.advance(0);
    assert.ok(harness.button('退出全屏'));
    assert.equal(harness.button('全屏'), undefined);
    assert.match(harness.tree.props.className, /\bimmersive\b/);

    harness.video.webkitDisplayingFullscreen = false;
    harness.video.dispatchEvent(new Event('webkitendfullscreen'));
    await harness.advance(0);
    assert.equal(exits, 0, 'a native video end event must clear state without requesting another exit');
    const feedback = harness.elements.find(element => element.props.className === 'player-feedback');
    assert.match(feedback?.props.children, /系统视频全屏.*网页弹幕/);
    assert.ok(harness.button('全屏'));
    assert.equal(harness.button('退出全屏'), undefined);
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);

    await harness.click('全屏');
    assert.equal(entries, 2);
    harness.video.webkitDisplayingFullscreen = true;
    harness.video.dispatchEvent(new Event('webkitbeginfullscreen'));
    await harness.advance(0);
    await harness.click('退出全屏');
    assert.equal(exits, 1);
    harness.video.webkitDisplayingFullscreen = false;
    harness.video.dispatchEvent(new Event('webkitendfullscreen'));
    await harness.advance(0);
    assert.equal(harness.page.fullscreenElement, null);
    assert.equal(harness.page.webkitFullscreenElement, null);
    assert.ok(harness.button('全屏'));
    assert.equal(harness.button('退出全屏'), undefined);
    assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
  } finally { harness.restore(); }
});

for (const exit of ['native end', 'button exit'] as const) {
  test(`Player cancels an iOS fullscreen pause when followed by ${exit}`, async () => {
    const harness = await playerHarness({ touch: true });
    try {
      let exits = 0;
      harness.video.webkitEnterFullscreen = () => {
        harness.video.webkitDisplayingFullscreen = true;
        harness.video.dispatchEvent(new Event('webkitbeginfullscreen'));
      };
      harness.video.webkitExitFullscreen = () => { exits++; };
      harness.render();
      await harness.advance(0);
      await harness.click('全屏');
      harness.clearCalls();

      harness.video.paused = true;
      harness.emit('onPause');
      await harness.advance(100);
      assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), []);
      assert.deepEqual(harness.video.plays, [], 'reconcile must not resume playback while a native pause is pending');
      if (exit === 'button exit') {
        await harness.click('退出全屏');
        assert.equal(exits, 1);
        await harness.advance(400);
        assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), [], 'the exit button must cancel a pending pause before the native end event');
      }
      harness.video.webkitDisplayingFullscreen = false;
      harness.video.dispatchEvent(new Event('webkitendfullscreen'));
      await harness.advance(400);
      assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), [], 'leaving native video fullscreen must not pause the room');
      assert.ok(harness.button('全屏'));
      assert.equal(harness.button('退出全屏'), undefined);
      assert.doesNotMatch(harness.tree.props.className, /\bimmersive\b/);
    } finally { harness.restore(); }
  });
}

test('Player discovers Safari picture-in-picture after metadata and follows presentation events', async () => {
  const harness = await playerHarness();
  try {
    let supported = false;
    harness.video.webkitSupportsPresentationMode = () => supported;
    harness.video.webkitSetPresentationMode = mode => {
      harness.video.webkitPresentationMode = mode;
      harness.video.dispatchEvent(new Event('webkitpresentationmodechanged'));
    };
    harness.render();
    assert.equal(harness.button('画中画'), undefined);
    supported = true;
    harness.video.dispatchEvent(new Event('loadedmetadata'));
    await harness.advance(0);
    assert.ok(harness.button('画中画'));
    harness.clearCalls();
    await harness.click('画中画');
    assert.equal(harness.video.webkitPresentationMode, 'picture-in-picture');
    assert.ok(harness.button('退出画中画'));
    assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), []);
    await harness.click('退出画中画');
    assert.equal(harness.video.webkitPresentationMode, 'inline');
  } finally { harness.restore(); }
});

test('Player keeps hidden picture-in-picture synchronized with room pause, resume, seek and rate', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    await harness.advance(1000);
    harness.page.pictureInPictureElement = harness.video;
    harness.page.visibilityState = 'hidden';
    harness.clearCalls();
    harness.updatePlayback({ paused: true, position: 11, revision: 2, updatedAt: harness.epoch + harness.now() });
    await harness.advance(200);
    assert.equal(harness.video.paused, true);
    harness.updatePlayback({ paused: false, position: 11, revision: 3, updatedAt: harness.epoch + harness.now() });
    await harness.advance(200);
    assert.equal(harness.video.paused, false);
    harness.updatePlayback({ paused: true, position: 123.456, revision: 4, seekRevision: 1, updatedAt: harness.epoch + harness.now() });
    await harness.advance(200);
    assert.equal(harness.video.currentTime, 123.456);
    harness.updatePlayback({ rate: 1.5, revision: 5, updatedAt: harness.epoch + harness.now() });
    await harness.advance(200);
    assert.equal(harness.video.playbackRate, 1.5);
    assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), []);
  } finally { harness.restore(); }
});

test('Player removes reduced-motion danmaku after the configured display lifetime without animation events', async () => {
  const harness = await playerHarness();
  try {
    harness.render();
    harness.updateMessages([{ id: 'new-message', text: '这一幕真好', name: '朋友', createdAt: harness.epoch, videoTime: 10 }]);
    assert.equal(harness.elements.filter(element => element.props.className === 'danmaku-item').length, 1);
    await harness.advance(7900);
    assert.equal(harness.elements.filter(element => element.props.className === 'danmaku-item').length, 1);
    await harness.advance(200);
    assert.equal(harness.elements.filter(element => element.props.className === 'danmaku-item').length, 0);
  } finally { harness.restore(); }
});

test('Player forwards a sustained native iOS pause once after the fullscreen exit grace period', async () => {
  const harness = await playerHarness({ touch: true });
  try {
    harness.video.webkitEnterFullscreen = () => {
      harness.video.webkitDisplayingFullscreen = true;
      harness.video.dispatchEvent(new Event('webkitbeginfullscreen'));
    };
    harness.render();
    await harness.advance(0);
    await harness.click('全屏');
    harness.clearCalls();

    harness.video.paused = true;
    harness.emit('onPause');
    await harness.advance(200);
    assert.deepEqual(harness.messages.filter(message => message.data.type === 'control'), []);
    assert.deepEqual(harness.video.plays, []);
    await harness.advance(200);
    assert.deepEqual(harness.messages.filter(message => message.data.type === 'control').map(message => message.data), [{ type: 'control', action: 'pause' }]);
    assert.deepEqual(harness.video.plays, []);
    assert.ok(harness.button('退出全屏'));
    harness.updatePlayback({ paused: true, position: harness.video.currentTime, revision: 2, updatedAt: harness.epoch + harness.now() });
    await harness.advance(1000);
    assert.equal(harness.messages.filter(message => message.data.type === 'control').length, 1);
    assert.deepEqual(harness.video.plays, []);
    assert.deepEqual(harness.video.pauses, []);
  } finally { harness.restore(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import type { Voice } from '../src/useVoice';

async function harness() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const states: any[] = [], refs: { current: any }[] = [], effects: { dependencies: unknown[]; callback: () => void | (() => void); cleanup?: () => void }[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  let scheduled: (() => void)[] = [];
  const changed = (before: unknown[], after: unknown[]) => before.length !== after.length || before.some((value, index) => !Object.is(value, after[index]));
  const hooks = {
    useRef(value: unknown) { const index = refIndex++; return refs[index] ||= { current: value }; },
    useState(value: any) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof value === 'function' ? value() : value;
      return [states[index], (next: any) => { states[index] = typeof next === 'function' ? next(states[index]) : next; }];
    },
    useCallback(callback: Function) { return callback; },
    useSyncExternalStore(_subscribe: Function, snapshot: Function) { return snapshot(); },
    useEffect(callback: () => void | (() => void), dependencies: unknown[]) {
      const index = effectIndex++, previous = effects[index];
      if (!previous || changed(previous.dependencies, dependencies)) scheduled.push(() => {
        previous?.cleanup?.(); const cleanup = callback(); effects[index] = { dependencies, callback, cleanup: cleanup || undefined };
      });
    },
  };
  const window = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const audios: AudioMock[] = [];
  class AudioMock {
    autoplay = false;
    srcObject: MediaStream | null = null;
    plays = 0;
    pauses = 0;
    blocked = true;
    pending?: Promise<void>;
    constructor() { audios.push(this); }
    setAttribute() {}
    pause() { this.pauses++; }
    play() { this.plays++; return this.pending || (this.blocked ? Promise.reject(new Error('NotAllowedError')) : Promise.resolve()); }
  }
  const controllers: Controller[] = [];
  class Controller {
    state = {
      available: true, enabled: false, mode: 'call', status: 'off', phase: 'idle', authenticated: false,
      friendMode: null, muted: false, holding: false, talking: false, listening: false, error: '',
    };
    suspended = 0;
    disabled = 0;
    constructor(public options: unknown, public dependencies: { onRemoteStream: (stream: MediaStream | null) => void }) { controllers.push(this); }
    getSnapshot = () => this.state;
    subscribe = () => () => {};
    update = (options: unknown) => { this.options = options; };
    enable = () => { this.state.enabled = true; };
    disable = () => { this.disabled++; this.state.enabled = false; this.dependencies.onRemoteStream(null); };
    suspend = () => { this.suspended++; };
    setMode() {} call() {} accept() {} reject() {} hangUp() {} toggleMute() {} startTalking() {} stopTalking() {}
  }
  replace('__voiceTestHooks', hooks); replace('__voiceTestController', Controller);
  replace('Audio', AudioMock); replace('window', window); replace('document', document);
  try {
    const output = await build({
      entryPoints: ['src/useVoice.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
      plugins: [{ name: 'voice-hook-stubs', setup(builder) {
        builder.onResolve({ filter: /^(react|\.\/voice)$/ }, args => ({ path: args.path, namespace: 'voice-test' }));
        builder.onLoad({ filter: /.*/, namespace: 'voice-test' }, args => ({ contents: args.path === 'react'
          ? 'export const {useRef,useState,useCallback,useSyncExternalStore,useEffect}=globalThis.__voiceTestHooks;'
          : 'export const VoiceController=globalThis.__voiceTestController;' }));
      } }],
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${Math.random()}`);
    const props = { roomId: 'room', token: 'secret', clientId: 'self', friendId: 'friend', connected: true };
    const render = () => {
      stateIndex = 0; refIndex = 0; effectIndex = 0;
      const voice = module.useVoice(props) as Voice;
      const run = scheduled; scheduled = []; run.forEach(callback => callback());
      return voice;
    };
    const initial = render();
    return {
      initial, render, audios, controllers, window, document,
      strictEffects() { effects.forEach(effect => effect.cleanup?.()); effects.forEach(effect => { effect.cleanup = effect.callback() || undefined; }); },
      close() {
        effects.forEach(effect => effect.cleanup?.());
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
        }
      },
    };
  } catch (error) {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
    }
    throw error;
  }
}

test('hook creates one audio sink on opt-in, exposes blocked playback, and resumes only on explicit action', async () => {
  const h = await harness();
  try {
    assert.equal(h.audios.length, 0);
    h.initial.enable(); h.render().enable();
    assert.equal(h.audios.length, 1);
    const stream = {} as MediaStream;
    h.controllers[0].dependencies.onRemoteStream(stream);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(h.audios[0].srcObject, stream);
    assert.equal(h.render().audioBlocked, true);
    h.audios[0].blocked = false;
    await h.render().resumeAudio();
    assert.equal(h.render().audioBlocked, false);
    assert.equal(h.audios[0].plays, 2);
    h.render().disable();
    assert.equal(h.audios[0].srcObject, null);
  } finally { h.close(); }
});

test('hook ignores stale autoplay failures after the stream has been removed', async () => {
  const h = await harness();
  try {
    h.initial.enable();
    let reject!: (error: Error) => void;
    h.audios[0].pending = new Promise((_resolve, failure) => { reject = failure; });
    h.controllers[0].dependencies.onRemoteStream({} as MediaStream);
    h.controllers[0].dependencies.onRemoteStream(null);
    reject(new Error('late autoplay failure')); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.render().audioBlocked, false); assert.equal(h.audios[0].srcObject, null);
  } finally { h.close(); }
});

test('hook releases on blur, background, pagehide and cleanup and stays usable after StrictMode effect replay', async () => {
  const h = await harness();
  try {
    h.initial.enable();
    h.window.dispatchEvent(new Event('blur'));
    h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(h.controllers[0].suspended, 2);
    h.window.dispatchEvent(new Event('pagehide'));
    assert.equal(h.controllers[0].disabled, 1);
    h.strictEffects();
    assert.equal(h.audios[0].srcObject, null);
    h.render().enable();
    assert.equal(h.controllers.length, 1); assert.equal(h.controllers[0].state.enabled, true);
    assert.equal(h.audios.length, 2);
  } finally { h.close(); }
});

async function panelHarness(compact = false, initial: Record<string, unknown> = {}) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const replace = (name: string, value: unknown) => {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  const refs: { current: any }[] = [];
  const cleanup: (() => void)[] = [];
  const window = new EventTarget(), document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  let presses = 0, releases = 0;
  const voice = {
    available: true, enabled: true, mode: 'ptt', status: 'ready', phase: 'idle', authenticated: true, friendMode: 'ptt',
    muted: false, holding: false, talking: false, listening: false, error: '', audioBlocked: false,
    startTalking() { presses++; voice.holding = true; }, stopTalking() { releases++; voice.holding = false; },
    setMode() {}, enable() {}, disable() {}, call() {}, accept() {}, reject() {}, toggleMute() {}, hangUp() {}, resumeAudio() {},
    ...initial,
  };
  const hooks = {
    useState(value: unknown) { return [value, () => {}]; },
    useRef(value: unknown) { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect(callback: () => (() => void) | undefined) { const result = callback(); if (result) cleanup.push(result); },
  };
  replace('__voicePanelHooks', hooks); replace('window', window); replace('document', document);
  try {
    const output = await build({
      entryPoints: ['src/VoicePanel.tsx'], bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
      plugins: [{ name: 'voice-panel-stubs', setup(builder) {
        builder.onResolve({ filter: /^(react|react\/jsx-runtime|lucide-react|\.\/voice\.css)$/ }, args => ({ path: args.path, namespace: 'voice-panel' }));
        builder.onLoad({ filter: /.*/, namespace: 'voice-panel' }, args => ({ contents: {
          react: 'export const {useRef,useEffect,useState}=globalThis.__voicePanelHooks;',
          'react/jsx-runtime': 'export function jsx(type,props){return {type,props};} export const jsxs=jsx; export const Fragment=Symbol();',
          'lucide-react': 'const Icon=()=>null; export {Icon as Headphones,Icon as Mic,Icon as MicOff,Icon as Phone,Icon as PhoneOff,Icon as Radio,Icon as Volume2};',
          './voice.css': '',
        }[args.path] }));
      } }],
    });
    const module = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${Math.random()}`);
    const tree = module.VoicePanel({ voice, compact });
    let button: any;
    const walk = (element: any) => {
      if (Array.isArray(element)) return element.forEach(walk);
      if (!element?.props) return;
      if (element.props.className?.startsWith('voice-hold')) button = element.props;
      walk(element.props.children);
    };
    walk(tree);
    let captured: number | null = null;
    const element = {
      focus() {}, setPointerCapture(id: number) { captured = id; },
      hasPointerCapture(id: number) { return id === captured; }, releasePointerCapture() { captured = null; },
    };
    const event = (values: Record<string, unknown> = {}) => {
      const result = { currentTarget: element, button: 0, pointerId: 7, key: '', repeat: false, prevented: false, stopped: false,
        preventDefault() { result.prevented = true; }, stopPropagation() { result.stopped = true; }, ...values };
      return result;
    };
    return {
      tree, button, event, window, document, voice, get presses() { return presses; }, get releases() { return releases; },
      get captured() { return captured; },
      close() {
        cleanup.forEach(callback => callback());
        for (const [name, descriptor] of saved) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
        }
      },
    };
  } catch (error) {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete (globalThis as any)[name];
    }
    throw error;
  }
}

test('compact panel starts collapsed, keeps the PTT button, and expands for incoming calls or playback errors', async () => {
  for (const [initial, open] of [[{}, false], [{ phase: 'incoming' }, true], [{ audioBlocked: true }, true], [{ error: '声音播放失败' }, true]] as const) {
    const h = await panelHarness(true, initial);
    try {
      const children = h.tree.props.children;
      const toggle = children[0].props.children;
      assert.equal(toggle.props['aria-expanded'], open);
      assert.equal(children[1].props.hidden, !open);
      assert.ok(h.button, 'PTT stays available while the settings are collapsed');
    } finally { h.close(); }
  }
});

test('PTT button captures the pointer and releases for up, cancel, lost capture and blur', async () => {
  const h = await panelHarness();
  try {
    for (const eventName of ['onPointerUp', 'onPointerCancel', 'onLostPointerCapture', 'onBlur']) {
      h.button.onPointerDown(h.event()); assert.equal(h.captured, 7);
      const before = h.releases; h.button[eventName](h.event());
      assert.equal(h.releases, before + 1); assert.equal(h.captured, null);
    }
    h.button.onPointerDown(h.event({ button: 2 }));
    assert.equal(h.presses, 4, 'secondary clicks never start capture');
  } finally { h.close(); }
});

test('PTT keyboard is hold-to-talk without repeat or player shortcut propagation', async () => {
  const h = await panelHarness();
  try {
    for (const key of [' ', 'Enter']) {
      const down = h.event({ key }); h.button.onKeyDown(down);
      assert.equal(down.prevented, true); assert.equal(down.stopped, true);
      h.button.onKeyDown(h.event({ key, repeat: true }));
      const up = h.event({ key }); h.button.onKeyUp(up);
      assert.equal(up.prevented, true); assert.equal(up.stopped, true);
    }
    assert.equal(h.presses, 2); assert.equal(h.releases, 2);
    h.button.onKeyDown(h.event({ key: ' ' })); h.window.dispatchEvent(new Event('blur'));
    assert.equal(h.releases, 3);
    h.button.onKeyDown(h.event({ key: 'Enter' }));
    h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(h.releases, 4);
  } finally { h.close(); }
});

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import Hls from 'hls.js';
import { ArrowLeft, Check, ChevronDown, Maximize, MessageSquare, Minimize, Pause, Play, RotateCcw, RotateCw, Send, Volume2, VolumeX, X } from 'lucide-react';
import type { Media, Message, PeerTelemetry, Playback } from './room';
import { chooseCorrection, projectPosition } from './sync';
import { useViewport } from './viewport';
import { danmakuColors, danmakuStorageKey, defaultDanmaku, loadDanmaku, type DanmakuPreferences } from './danmaku';
import { findReaction, reactions, reactionText } from './reactions';
import ReactionContent from './ReactionContent';
import { isPictureInPicture, supportsPictureInPicture, togglePictureInPicture } from './pip';

export function formatTime(value: number, precise = false) {
  const milliseconds = Math.max(0, Math.round((Number.isFinite(value) ? value : 0) * 1000));
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const time = `${hours ? `${hours}:` : ''}${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return precise ? `${time}.${String(milliseconds % 1000).padStart(3, '0')}` : time;
}

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenContainer = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitDisplayingFullscreen?: boolean;
};

type Props = {
  media: Media | null;
  playback?: Playback;
  userPaused: boolean;
  serverNow: () => number;
  clockReady: boolean;
  peerTelemetry: PeerTelemetry | null;
  send: (data: object) => boolean;
  messages: Message[];
  connected: boolean;
  onTyping: (typing: boolean) => void;
  onSource: () => void;
  voiceControls?: ReactNode;
};

export default function Player({ media, playback, userPaused, serverNow, clockReady, peerTelemetry, send, messages, connected, onTyping, onSource, voiceControls }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const viewport = useViewport();
  const [cinema, setCinema] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const [videoFullscreen, setVideoFullscreen] = useState(false);
  const fullscreenPending = useRef(false);
  const nativeVideoActive = useRef(false);
  const nativePauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scriptedSeek = useRef<number | null>(null);
  const seekVideo = useCallback((element: HTMLVideoElement, position: number) => {
    scriptedSeek.current = position; element.currentTime = position;
  }, []);
  const actualFullscreen = nativeFullscreen || videoFullscreen;
  const fullscreenActive = actualFullscreen || cinema;
  const fullscreenLabel = actualFullscreen ? '退出全屏' : cinema ? '退出网页沉浸模式' : '全屏';
  const [landscapeDismissed, setLandscapeDismissed] = useState(false);
  const immersive = fullscreenActive || (media?.kind === 'video' && viewport.touch && viewport.landscape && !landscapeDismissed);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [error, setError] = useState('');
  const [needsGesture, setNeedsGesture] = useState(false);
  const [retry, setRetry] = useState(0);
  const [visible, setVisible] = useState(true);
  const [activity, setActivity] = useState(0);
  const [writing, setWriting] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [text, setText] = useState('');
  const [danmaku, setDanmaku] = useState(true);
  const [preferences, setPreferences] = useState(loadDanmaku);
  const [danmakuSettings, setDanmakuSettings] = useState(false);
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const [pipAvailable, setPipAvailable] = useState(false);
  const [pipActive, setPipActive] = useState(false);
  const [settings, setSettings] = useState(false);
  const [preview, setPreview] = useState<number | null>(null);
  const [feedback, setFeedback] = useState('');
  const [drift, setDrift] = useState<number | null>(null);
  const [peerDrift, setPeerDrift] = useState<number | null>(null);
  const [bursts, setBursts] = useState<(Message & { lane: number; shownAt: number })[]>([]);
  const latest = useRef({ playback, userPaused, connected, clockReady, peerTelemetry });
  latest.current = { playback, userPaused, connected, clockReady, peerTelemetry };
  const dragging = useRef(false);
  const previewRef = useRef<number | null>(null);
  const appliedSeekRevision = useRef<number | null>(null);
  const pendingAlignment = useRef(true);
  const wasUserPaused = useRef(userPaused);
  const lastRateAt = useRef(-Infinity);
  const stableSince = useRef<number | null>(null);
  const waitingSince = useRef<number | null>(null);
  const driftSince = useRef<number | null>(null);
  const seen = useRef(new Set<string>());
  const lane = useRef(0);
  const tap = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const touchStart = useRef<{ x: number; y: number; position: number; moved: boolean } | null>(null);
  const statusRef = useRef('');
  const playbackAttempt = useRef(false);
  const gestureBlocked = useRef(false);
  const fatalError = useRef(false);
  const suppressTapUntil = useRef(0);
  const commandPendingUntil = useRef(0);
  const lastSeekAt = useRef(-Infinity);
  const waitingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const expectedPause = useRef(0);
  const pauseVideo = useCallback((element: HTMLVideoElement) => {
    if (!element.paused) { expectedPause.current += 1; element.pause(); }
  }, []);
  useEffect(() => { setLandscapeDismissed(false); }, [viewport.landscape]);
  const acknowledge = useCallback((message: string) => setFeedback(message), []);
  const reveal = useCallback(() => { setVisible(true); setActivity(value => value + 1); }, []);

  useEffect(() => { onTyping(writing); return () => onTyping(false); }, [writing, onTyping]);
  useEffect(() => {
    const element = video.current;
    if (!element || media?.kind !== 'video') { setPipAvailable(false); setPipActive(false); return; }
    const changed = () => {
      setPipAvailable(supportsPictureInPicture(element));
      setPipActive(isPictureInPicture(element));
    };
    element.addEventListener('loadedmetadata', changed);
    element.addEventListener('canplay', changed);
    element.addEventListener('emptied', changed);
    element.addEventListener('enterpictureinpicture', changed);
    element.addEventListener('leavepictureinpicture', changed);
    element.addEventListener('webkitpresentationmodechanged', changed);
    changed();
    return () => {
      element.removeEventListener('loadedmetadata', changed);
      element.removeEventListener('canplay', changed);
      element.removeEventListener('emptied', changed);
      element.removeEventListener('enterpictureinpicture', changed);
      element.removeEventListener('leavepictureinpicture', changed);
      element.removeEventListener('webkitpresentationmodechanged', changed);
    };
  }, [media?.kind, media?.id, media?.url]);
  useEffect(() => {
    const page = document as FullscreenDocument;
    const element = root.current;
    const mediaElement = video.current;
    let wasFullscreen = false;
    const changed = () => {
      const active = !!element && (page.fullscreenElement === element || page.webkitFullscreenElement === element);
      setNativeFullscreen(active);
      if (active) setCinema(false);
      else if (wasFullscreen) {
        setCinema(false); setLandscapeDismissed(true);
        setComposerOpen(false); setWriting(false); input.current?.blur(); reveal();
      }
      wasFullscreen = active;
    };
    const beginVideo = () => { nativeVideoActive.current = true; setVideoFullscreen(true); setCinema(false); };
    const endVideo = () => {
      clearTimeout(nativePauseTimer.current); nativePauseTimer.current = undefined;
      nativeVideoActive.current = false; setVideoFullscreen(false); setCinema(false); setLandscapeDismissed(true); reveal();
      acknowledge('系统视频全屏不显示网页弹幕，回到这里可继续发送');
    };
    page.addEventListener('fullscreenchange', changed);
    page.addEventListener('webkitfullscreenchange', changed);
    mediaElement?.addEventListener('webkitbeginfullscreen', beginVideo);
    mediaElement?.addEventListener('webkitendfullscreen', endVideo);
    changed();
    return () => {
      page.removeEventListener('fullscreenchange', changed);
      page.removeEventListener('webkitfullscreenchange', changed);
      mediaElement?.removeEventListener('webkitbeginfullscreen', beginVideo);
      mediaElement?.removeEventListener('webkitendfullscreen', endVideo);
    };
  }, [media?.kind, reveal, acknowledge]);
  useEffect(() => {
    if (!visible || paused || writing || composerOpen || dragging.current || settings || danmakuSettings || reactionsOpen || needsGesture || error) return;
    const timer = setTimeout(() => setVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [visible, paused, writing, composerOpen, preview, settings, danmakuSettings, reactionsOpen, needsGesture, error, activity]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(''), 2600);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => () => { clearTimeout(tap.current); clearTimeout(waitingTimer.current); clearTimeout(nativePauseTimer.current); }, []);

  const reportStatus = useCallback((force = false) => {
    const v = video.current;
    if (!v || !latest.current.connected) return;
    const now = performance.now();
    const blocked = !!v.error || fatalError.current || gestureBlocked.current;
    const ready = v.readyState >= 3 && !blocked;
    if (ready) waitingSince.current = null;
    else if (!blocked) {
      waitingSince.current ??= now;
      if (now - waitingSince.current < 1200) return;
    }
    const waiting = !ready;
    setBuffering(waiting);
    const signature = `${ready}:${waiting}`;
    if (force || signature !== statusRef.current) {
      if (send({ type: 'status', ready, buffering: waiting })) statusRef.current = signature;
    }
  }, [send]);

  useEffect(() => {
    setError(''); setSettings(false); setDanmakuSettings(false); setReactionsOpen(false);
    const v = video.current;
    if (!v || !media || media.kind !== 'video') return;
    let disposed = false;
    let hls: Hls | undefined;
    setError(''); setCurrent(0); setDuration(0); setBuffered(0); setBuffering(true);
    setNeedsGesture(false); setVisible(true); setPreview(null);
    appliedSeekRevision.current = null; pendingAlignment.current = true;
    wasUserPaused.current = latest.current.userPaused;
    stableSince.current = null; waitingSince.current = null; driftSince.current = null;
    lastSeekAt.current = -Infinity; lastRateAt.current = -Infinity;
    statusRef.current = ''; dragging.current = false;
    gestureBlocked.current = false; fatalError.current = false;
    if (media.url.includes('.m3u8')) {
      if (v.canPlayType('application/vnd.apple.mpegurl')) v.src = media.url;
      else if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 });
        hls.attachMedia(v);
        hls.loadSource(media.url);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (disposed || !data.fatal) return;
          setBuffering(false); fatalError.current = true;
          send({ type: 'status', ready: false, buffering: true });
          setError(data.response?.code === 403 ? '片源拒绝访问，链接可能已经过期。请更换链接。' : '片源加载失败，请检查跨域权限、链接时效或网络。');
        });
      } else setError('当前浏览器无法播放 HLS，请使用新版 Chrome 或 Safari。');
    } else v.src = media.url;
    if (!hls) v.load();
    return () => {
      disposed = true; hls?.destroy(); pauseVideo(v); v.removeAttribute('src'); v.load();
    };
  }, [media?.url, media?.kind, media?.id, retry]);

  useEffect(() => {
    if (!connected || media?.kind !== 'video') return;
    reportStatus(true);
    const timer = setInterval(() => reportStatus(true), 3000);
    return () => clearInterval(timer);
  }, [connected, media?.id, media?.url, reportStatus]);

  useEffect(() => {
    const reconcile = () => {
      const v = video.current;
      const state = latest.current;
      const p = state.playback;
      const local = performance.now();
      if (v && p?.paused && state.connected && local >= commandPendingUntil.current) pauseVideo(v);
      if (!v || !p || !state.connected || !state.clockReady || v.readyState < 1 || dragging.current || local < commandPendingUntil.current || (document.visibilityState === 'hidden' && !isPictureInPicture(v))) {
        stableSince.current = null; driftSince.current = null;
        setDrift(null); setPeerDrift(null); return;
      }
      if (state.userPaused && !wasUserPaused.current) pendingAlignment.current = true;
      wasUserPaused.current = state.userPaused;
      if ((gestureBlocked.current || nativePauseTimer.current !== undefined) && !p.paused) { setDrift(null); setPeerDrift(null); return; }
      const seekRevision = p.seekRevision ?? 0;
      const force = pendingAlignment.current || appliedSeekRevision.current !== seekRevision;
      const now = serverNow();
      const end = Number.isFinite(v.duration) ? v.duration : Infinity;
      const target = Math.min(end, projectPosition(p, now));
      const available = v.readyState >= 3 && !v.seeking;
      if (!available) { stableSince.current = null; driftSince.current = null; }
      else stableSince.current ??= local;
      const correction = chooseCorrection(v.currentTime, target, p.paused, p.rate, force);
      const stable = available && stableSince.current !== null && local - stableSince.current >= 1500;
      let aligning = false;
      if (force && !v.seeking) {
        if (correction.seek !== null) {
          lastSeekAt.current = local; stableSince.current = null; seekVideo(v, correction.seek);
          aligning = true;
        }
        appliedSeekRevision.current = seekRevision; pendingAlignment.current = false;
      } else if (!force && !p.paused && stable && correction.seek !== null) {
        driftSince.current ??= local;
        if (local - driftSince.current >= 2500 && local - lastSeekAt.current >= 10000) {
          lastSeekAt.current = local; stableSince.current = null; driftSince.current = null;
          seekVideo(v, correction.seek); aligning = true;
        }
      } else driftSince.current = null;
      const baseRateChanged = Math.abs(v.playbackRate - p.rate) > p.rate * 0.051;
      if (available && !aligning && (stable || baseRateChanged || p.paused)) {
        const rate = stable && correction.seek === null ? correction.rate : p.rate;
        if (Math.abs(v.playbackRate - rate) > 0.0001 && (baseRateChanged || p.paused || local - lastRateAt.current >= 1500)) {
          v.playbackRate = rate; lastRateAt.current = local;
        }
      }
      if (!p.paused && available && !aligning && v.paused && !v.ended && !gestureBlocked.current && !playbackAttempt.current) {
        playbackAttempt.current = true;
        v.play().then(() => { gestureBlocked.current = false; setNeedsGesture(false); reportStatus(); }).catch((failure: DOMException) => {
          if (failure.name === 'NotAllowedError') { gestureBlocked.current = true; setNeedsGesture(true); reportStatus(); }
        }).finally(() => { playbackAttempt.current = false; });
      }
      setDrift(v.seeking || v.readyState < 3 ? null : Math.round((v.currentTime - target) * 1000));
      const peer = state.peerTelemetry;
      if (peer && peer.revision === p.revision && now - peer.measuredAt < 5000 && now >= peer.measuredAt - 500 && !v.seeking && v.readyState >= 3) {
        const peerPosition = peer.position + (peer.paused ? 0 : Math.max(0, now - peer.measuredAt) / 1000 * peer.rate);
        setPeerDrift(Math.round((v.currentTime - peerPosition) * 1000));
      } else setPeerDrift(null);
    };
    reconcile();
    const timer = setInterval(reconcile, 200);
    return () => clearInterval(timer);
  }, [serverNow, media?.id, media?.url, reportStatus, pauseVideo, seekVideo]);

  useEffect(() => {
    if (!connected || !clockReady || media?.kind !== 'video') return;
    const timer = setInterval(() => {
      const v = video.current, p = latest.current.playback;
      if (v && p && v.readyState >= 2 && !v.seeking && !dragging.current) {
        send({ type: 'telemetry', position: v.currentTime, paused: v.paused, rate: v.playbackRate, revision: p.revision, measuredAt: serverNow() });
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [connected, clockReady, media?.id, media?.url, serverNow, send]);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    let handle = 0;
    let lastUpdate = -Infinity;
    const frame = (now: number) => {
      if (!dragging.current && now - lastUpdate >= 250) { setCurrent(v.currentTime); lastUpdate = now; }
      handle = v.requestVideoFrameCallback(frame);
    };
    if ('requestVideoFrameCallback' in v) handle = v.requestVideoFrameCallback(frame);
    return () => { if (handle) v.cancelVideoFrameCallback(handle); };
  }, [media?.url, media?.id]);

  useEffect(() => {
    const incoming = messages.filter(message => !seen.current.has(message.id));
    messages.forEach(message => seen.current.add(message.id));
    if (seen.current.size > 200) seen.current = new Set(messages.map(message => message.id));
    if (danmaku) {
      const recent = incoming.filter(message => Math.abs(serverNow() - message.createdAt) < 8000);
      if (recent.length) setBursts(previous => [...previous, ...recent.map(message => ({ ...message, lane: lane.current++ % 4, shownAt: performance.now() }))].slice(-12));
    }
  }, [messages, danmaku, serverNow]);
  useEffect(() => {
    if (!bursts.length) return;
    const remaining = Math.min(...bursts.map(message => message.shownAt + preferences.duration * 1000 - performance.now()));
    const timer = setTimeout(() => setBursts(previous => previous.filter(message => performance.now() - message.shownAt < preferences.duration * 1000)), Math.max(1, remaining));
    return () => clearTimeout(timer);
  }, [bursts, preferences.duration]);

  function control(action: 'play' | 'pause' | 'seek' | 'rate', value?: number) {
    if (!connected || !media) { acknowledge('请先连接房间并添加片源'); return false; }
    commandPendingUntil.current = performance.now() + 700;
    return send({ type: 'control', action, ...(action === 'seek' ? { position: value } : {}), ...(action === 'rate' ? { rate: value } : {}) });
  }
  function togglePlay() {
    const v = video.current;
    if (!v) return;
    reveal();
    if (needsGesture) {
      v.play().then(() => { gestureBlocked.current = false; setNeedsGesture(false); reportStatus(true); }).catch(() => acknowledge('浏览器未允许播放，请再点击一次'));
      return;
    }
    const action = latest.current.userPaused ? 'play' : 'pause';
    if (action === 'play') v.play().then(() => { gestureBlocked.current = false; setNeedsGesture(false); reportStatus(); }).catch(() => { gestureBlocked.current = true; setNeedsGesture(true); reportStatus(); });
    if (control(action) && action === 'pause') pauseVideo(v);
  }
  function beginSeek(value: number) {
    dragging.current = true; previewRef.current = value; setPreview(value); reveal();
  }
  function commitSeek() {
    const value = previewRef.current;
    if (value !== null && dragging.current) {
      const target = Math.max(0, Math.min(duration || value, value));
      if (control('seek', target) && video.current) { lastSeekAt.current = performance.now(); seekVideo(video.current, target); }
      setCurrent(target);
    }
    dragging.current = false; previewRef.current = null; setPreview(null); reveal();
  }
  function skip(seconds: number) {
    const target = Math.max(0, Math.min(duration || Infinity, (video.current?.currentTime || 0) + seconds));
    if (control('seek', target) && video.current) { lastSeekAt.current = performance.now(); seekVideo(video.current, target); }
    reveal(); acknowledge(`${seconds > 0 ? '快进' : '后退'} ${Math.abs(seconds)} 秒`);
  }
  function stageClick() {
    if (performance.now() < suppressTapUntil.current) return;
    if (tap.current) { clearTimeout(tap.current); tap.current = undefined; togglePlay(); return; }
    tap.current = setTimeout(() => { setVisible(value => !value); tap.current = undefined; }, 230);
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || (event.target as HTMLElement).closest('input,textarea,select,button,[data-voice-controls]')) return;
    if (event.key === ' ' || event.key.toLowerCase() === 'k') { event.preventDefault(); togglePlay(); }
    if (event.key === 'ArrowRight') { event.preventDefault(); skip(10); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); skip(-10); }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); void fullscreen(); }
    if (event.key === 'Escape') { setCinema(false); setWriting(false); setComposerOpen(false); setSettings(false); setDanmakuSettings(false); setReactionsOpen(false); input.current?.blur(); }
  }
  async function exitFullscreen() {
    clearTimeout(nativePauseTimer.current); nativePauseTimer.current = undefined;
    const page = document as FullscreenDocument;
    const mediaElement = video.current as FullscreenVideo | null;
    if (page.fullscreenElement === root.current && page.exitFullscreen) await page.exitFullscreen();
    else if (page.webkitFullscreenElement === root.current && page.webkitExitFullscreen) await page.webkitExitFullscreen();
    else if ((videoFullscreen || mediaElement?.webkitDisplayingFullscreen) && mediaElement?.webkitExitFullscreen) mediaElement.webkitExitFullscreen();
    setCinema(false); setLandscapeDismissed(true);
    setComposerOpen(false); setWriting(false); input.current?.blur(); reveal();
  }
  async function fullscreen() {
    if (fullscreenPending.current) return;
    reveal();
    if (fullscreenActive) {
      try { await exitFullscreen(); }
      catch { acknowledge('退出全屏失败，请使用浏览器返回键或 Esc'); }
      return;
    }
    const element = root.current as FullscreenContainer | null;
    const mediaElement = video.current as FullscreenVideo | null;
    fullscreenPending.current = true;
    try {
      if (element?.requestFullscreen && document.fullscreenEnabled !== false) {
        await element.requestFullscreen({ navigationUI: 'hide' });
      } else if (element?.webkitRequestFullscreen) {
        await element.webkitRequestFullscreen();
      } else if (mediaElement?.webkitEnterFullscreen) {
        mediaElement.webkitEnterFullscreen();
      } else {
        setCinema(true);
        acknowledge('当前浏览器不支持真正全屏，已进入网页沉浸模式');
      }
    } catch {
      setCinema(true);
      acknowledge('浏览器未允许全屏，已进入网页沉浸模式；可尝试用系统浏览器打开');
    } finally { fullscreenPending.current = false; }
  }
  async function changeSource() {
    try { await exitFullscreen(); onSource(); }
    catch { acknowledge('请先退出全屏，再更换片源'); }
  }
  function openComposer() {
    setSettings(false); setDanmakuSettings(false); setReactionsOpen(false); flushSync(() => setComposerOpen(true)); reveal();
    input.current?.focus({ preventScroll: true });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    if (send({ type: 'chat', text: text.trim() })) { setText(''); acknowledge('弹幕已发送'); }
    else acknowledge('连接已断开，消息尚未发送');
  }
  function updatePreferences(value: DanmakuPreferences) {
    setPreferences(value);
    try { localStorage.setItem(danmakuStorageKey, JSON.stringify(value)); }
    catch { acknowledge('当前浏览器无法保存设置，本次观看仍然生效'); }
  }
  function sendReaction(id: typeof reactions[number]['id']) {
    if (send({ type: 'chat', text: reactionText(id) })) { setReactionsOpen(false); acknowledge('表情已发送'); }
    else acknowledge('连接已断开，表情尚未发送');
    reveal();
  }
  async function pictureInPicture() {
    const element = video.current;
    if (!element) return;
    try {
      if (immersive) await exitFullscreen();
      await togglePictureInPicture(element);
      setPipActive(isPictureInPicture(element));
      acknowledge('画中画只显示视频，弹幕和语音操作仍在页面里');
    } catch (failure) { acknowledge(failure instanceof Error ? failure.message : '无法开启画中画，请在系统浏览器中重试'); }
    reveal();
  }
  const usableDuration = Number.isFinite(duration) ? duration : 0;
  const progress = usableDuration ? Math.min(100, (preview ?? current) / usableDuration * 100) : 0;
  const driftLabel = drift === null ? '正在校准' : `${drift >= 0 ? '+' : ''}${drift} ms`;
  return <div ref={root} className={`watch-player ${immersive ? 'immersive' : ''} ${writing || composerOpen ? 'is-writing' : ''} ${!visible ? 'controls-hidden' : ''}`} style={{ '--visible-height': `${viewport.height}px`, '--visible-top': `${viewport.top}px`, '--danmaku-size': `${preferences.size}px`, '--danmaku-opacity': preferences.opacity, '--danmaku-duration': `${preferences.duration}s`, '--danmaku-color': preferences.color, '--reaction-size': `${preferences.size * 3.5}px` } as CSSProperties} onKeyDown={keydown} tabIndex={0} aria-label="共同播放器">
    <div className="video-stage" onPointerMove={event => { if (event.pointerType === 'mouse') reveal(); }}>
      {!media ? <div className="player-empty"><div className="projector-illustration" aria-hidden="true" /><h2>准备好，一起开场。</h2><p>添加视频链接，邀请朋友入座。</p><button className="button" disabled={!connected} onClick={() => void changeSource()}>添加片源</button></div> : media.kind === 'web' ? <div className="web-player"><iframe title="共同浏览网页" src={media.url} sandbox="allow-scripts allow-same-origin allow-forms allow-presentation" allow="fullscreen; autoplay" referrerPolicy="no-referrer" /><div className="web-notice">第三方网页中的播放器无法自动同步。<a href={media.url} target="_blank" rel="noreferrer">新窗口打开</a></div></div> : <>
        <video ref={video} playsInline preload="auto" onTimeUpdate={event => { if (!dragging.current) setCurrent(event.currentTarget.currentTime); }} onDurationChange={event => setDuration(event.currentTarget.duration)} onProgress={event => { const v = event.currentTarget; if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1)); }} onLoadedMetadata={() => reportStatus(true)} onPlay={() => { clearTimeout(nativePauseTimer.current); nativePauseTimer.current = undefined; setPaused(false); reveal(); if (nativeVideoActive.current && latest.current.userPaused) control('play'); }} onPause={() => {
          setPaused(true); setVisible(true);
          if (expectedPause.current > 0) { expectedPause.current -= 1; return; }
          const v = video.current;
          if (nativeVideoActive.current && v && !v.ended && !v.seeking) {
            clearTimeout(nativePauseTimer.current);
            nativePauseTimer.current = setTimeout(() => {
              nativePauseTimer.current = undefined;
              if (nativeVideoActive.current && video.current?.paused) control('pause');
            }, 300);
            return;
          }
          if (v && latest.current.playback?.paused === false && !latest.current.userPaused && !v.seeking && !v.ended && performance.now() >= commandPendingUntil.current) {
            gestureBlocked.current = true; setNeedsGesture(true); reportStatus();
          }
        }} onWaiting={() => { waitingSince.current ??= performance.now(); clearTimeout(waitingTimer.current); waitingTimer.current = setTimeout(() => reportStatus(), 1250); }} onCanPlay={() => { clearTimeout(waitingTimer.current); reportStatus(); }} onPlaying={() => { gestureBlocked.current = false; setNeedsGesture(false); reportStatus(); }} onSeeked={() => {
          const v = video.current;
          if (nativeVideoActive.current && v && (scriptedSeek.current === null || Math.abs(v.currentTime - scriptedSeek.current) > 0.1)) control('seek', v.currentTime);
          scriptedSeek.current = null; reportStatus(true);
        }} onEnded={() => { control('pause'); setVisible(true); }} onError={event => { if (event.currentTarget.error) { fatalError.current = true; reportStatus(true); setBuffering(false); setError('视频无法加载，请检查片源是否过期或更换链接。'); } }} />
        <div className="video-touch" aria-label="轻触显隐，双击播放或暂停" onClick={stageClick} onPointerDown={event => { if (event.pointerType !== 'mouse') touchStart.current = { x: event.clientX, y: event.clientY, position: video.current?.currentTime || 0, moved: false }; }} onPointerMove={event => {
          const start = touchStart.current;
          if (!start || !usableDuration) return;
          const dx = event.clientX - start.x, dy = event.clientY - start.y;
          if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            start.moved = true;
            beginSeek(Math.min(usableDuration, Math.max(0, start.position + dx / event.currentTarget.clientWidth * 120)));
          }
        }} onPointerUp={event => { if (touchStart.current?.moved) { event.preventDefault(); suppressTapUntil.current = performance.now() + 400; commitSeek(); } touchStart.current = null; }} onPointerCancel={() => { dragging.current = false; previewRef.current = null; setPreview(null); touchStart.current = null; }} />
        {danmaku && <div className="danmaku" aria-hidden="true">{bursts.map(message => <span className="danmaku-item" key={message.id} style={{ top: findReaction(message.text) ? message.lane % 2 === 0 ? '6%' : preferences.area === 'full' ? 'calc(94% - min(var(--reaction-size), 16cqw))' : 'calc(6% + min(var(--reaction-size), 16cqw) + 8px)' : `${preferences.area === 'full' ? 8 + message.lane * 18 : 6 + message.lane * 10}%` }} onAnimationEnd={() => setBursts(previous => previous.filter(item => item.id !== message.id))}><ReactionContent text={message.text} /></span>)}</div>}
        <div className="player-top chrome" aria-hidden={!visible} inert={!visible}><button aria-label={fullscreenActive ? fullscreenLabel : '退出沉浸模式'} className="player-icon exit-cinema" onClick={() => void exitFullscreen().catch(() => acknowledge('请使用浏览器返回键退出全屏'))}><ArrowLeft size={22} /></button><strong>{media.title}</strong><span className="sync-indicator" title="本机相对房间时间线的估算偏差">{driftLabel}</span></div>
        {paused && !buffering && !error && !needsGesture && visible && <button className="center-play" aria-label={userPaused ? '播放电影' : '正在等待对方'} onClick={togglePlay}><Play size={34} fill="currentColor" /></button>}
        {needsGesture && <button className="gesture" onClick={togglePlay}><Play size={23} />点击加入播放</button>}
        {buffering && !error && <div className="buffer-tag" role="status"><span className="spinner" />{userPaused ? '正在加载片源' : '正在缓冲，稍等一下'}</div>}
        {preview !== null && <div className="seek-preview">{formatTime(preview, true)}<small>松手后与对方同步</small></div>}
        <div className="player-bottom chrome" aria-hidden={!visible} inert={!visible} onPointerDown={reveal}>
          <div className="timeline"><div className="buffered-track" style={{ width: `${usableDuration ? Math.min(100, buffered / usableDuration * 100) : 0}%` }} /><input aria-label="播放进度" type="range" min={0} max={usableDuration} step={0.001} value={Math.min(preview ?? current, usableDuration)} style={{ '--progress': `${progress}%` } as CSSProperties} disabled={!usableDuration || !connected} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); beginSeek(Number(event.currentTarget.value)); }} onChange={event => beginSeek(Number(event.target.value))} onPointerUp={commitSeek} onPointerCancel={() => { dragging.current = false; previewRef.current = null; setPreview(null); }} onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commitSeek(); }} onBlur={() => { if (dragging.current) commitSeek(); }} /></div>
          <div className="control-row"><button className="player-icon" aria-label={userPaused ? '播放' : '暂停'} onClick={togglePlay}>{paused ? <Play size={23} fill="currentColor" /> : <Pause size={23} fill="currentColor" />}</button><button className="player-icon skip" aria-label="后退10秒" onClick={() => skip(-10)}><RotateCcw size={20} /></button><button className="player-icon skip" aria-label="快进10秒" onClick={() => skip(10)}><RotateCw size={20} /></button><span className="play-time">{formatTime(preview ?? current)}<i>/</i>{formatTime(duration)}</span><div className="control-spacer" /><button className="player-text write-trigger" onClick={openComposer}><MessageSquare size={17} /><span>发弹幕</span></button><button className={`player-text danmaku-toggle ${danmaku ? 'active' : ''}`} aria-label="弹幕显示开关" aria-pressed={danmaku} onClick={() => { setDanmaku(value => !value); reveal(); }}>弹</button><button className="player-text" aria-label="播放设置" aria-expanded={settings} onClick={() => { setSettings(value => !value); setDanmakuSettings(false); setReactionsOpen(false); reveal(); }}>{playback?.rate || 1}×<ChevronDown size={12} /></button>{pipAvailable && <button className={`player-text pip-button ${pipActive ? 'active' : ''}`} aria-label={pipActive ? '退出画中画' : '画中画'} aria-pressed={pipActive} onClick={() => void pictureInPicture()}><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="11" y="11" width="7" height="6" rx="1" fill="currentColor" stroke="none" /></svg></button>}<button className="player-icon volume-button" aria-label={muted ? '取消静音' : '静音'} onClick={() => { if (video.current) video.current.muted = !muted; setMuted(!muted); }}>{muted ? <VolumeX size={20} /> : <Volume2 size={20} />}</button><button className="player-icon" aria-label={fullscreenLabel} onClick={() => void fullscreen()}>{fullscreenActive ? <Minimize size={21} /> : <Maximize size={21} />}</button></div>
        </div>
        {settings && <div className="player-settings"><div className="settings-heading">播放设置<button className="player-icon" aria-label="关闭播放设置" onClick={() => setSettings(false)}><X size={17} /></button></div><span>倍速（双方同步）</span><div className="rate-options">{[0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => <button key={rate} className={playback?.rate === rate ? 'selected' : ''} onClick={() => { control('rate', rate); setSettings(false); reveal(); }}>{rate}×</button>)}</div><label className="volume-range">音量<input type="range" aria-label="音量" min={0} max={1} step={0.05} value={volume} onChange={event => { const value = Number(event.target.value); setVolume(value); if (video.current) { video.current.volume = value; video.current.muted = value === 0; } setMuted(value === 0); }} /></label><div className="sync-detail"><span>本机对房间时间线<strong>{driftLabel}</strong></span><span>两端进度差（估算）<strong>{peerDrift === null ? '等待对方数据' : `${Math.abs(peerDrift)} ms`}</strong></span><small>网络、解码和视频帧率会影响实际误差。</small></div><button className="sync-now" onClick={() => { pendingAlignment.current = true; send({ type: 'sync' }); acknowledge('正在重新校准'); }}>立即校准<Check size={15} /></button></div>}
      </>}
      {feedback && <div className="player-feedback" role="status">{feedback}</div>}
      {error && <div className="player-error" role="alert"><strong>暂时无法播放</strong><p>{error}</p><div><button onClick={() => { setError(''); setRetry(value => value + 1); }}>重新加载</button><button onClick={() => void changeSource()}>更换片源</button></div></div>}
    </div>
    <form className={`danmaku-composer ${writing ? 'focused' : ''}`} onSubmit={submit}>
      <button type="button" className={`composer-tool ${reactionsOpen ? 'selected' : ''}`} aria-label="快捷表情" aria-expanded={reactionsOpen} onPointerDown={event => event.preventDefault()} onClick={() => { setReactionsOpen(value => !value); setDanmakuSettings(false); setSettings(false); reveal(); }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M8 14c1 3 7 3 8 0M8 9h.01M16 9h.01" strokeLinecap="round" /></svg></button><input ref={input} aria-label="弹幕消息" placeholder="发个弹幕，一起聊这一幕" value={text} onChange={event => setText(event.target.value)} onFocus={() => { setWriting(true); reveal(); }} onBlur={() => setWriting(false)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }} maxLength={500} enterKeyHint="send" disabled={!connected} />
      <button className="send-danmaku" aria-label="发送弹幕" disabled={!connected || !text.trim()} onPointerDown={event => event.preventDefault()}><Send size={17} /><span>发送</span></button>
      <button type="button" className="close-composer" aria-label="收起输入框" onPointerDown={event => event.preventDefault()} onClick={() => { input.current?.blur(); setWriting(false); setComposerOpen(false); }}><X size={19} /></button>
      <button type="button" className={`composer-tool danmaku-preferences ${danmakuSettings ? 'selected' : ''}`} aria-label="弹幕偏好" aria-expanded={danmakuSettings} onPointerDown={event => event.preventDefault()} onClick={() => { setDanmakuSettings(value => !value); setReactionsOpen(false); setSettings(false); reveal(); }}>弹</button>
    </form>
    {reactionsOpen && <section className="reaction-picker" role="dialog" aria-label="快捷表情"><div className="picker-heading"><strong>把感受发给对方</strong><button type="button" className="composer-tool" aria-label="关闭快捷表情" onClick={() => setReactionsOpen(false)}><X size={17} /></button></div><div className="reaction-grid">{reactions.map(reaction => <button type="button" key={reaction.id} aria-label={`发送表情：${reaction.label}`} title={reaction.label} disabled={!connected} onPointerDown={event => event.preventDefault()} onClick={() => sendReaction(reaction.id)}><img src={reaction.image} width="64" height="64" alt="" draggable={false} /><span>{reaction.label}</span></button>)}</div></section>}
    {danmakuSettings && <section className="danmaku-preferences-panel" role="dialog" aria-label="弹幕偏好"><div className="picker-heading"><strong>弹幕偏好</strong><button type="button" className="composer-tool" aria-label="关闭弹幕偏好" onClick={() => setDanmakuSettings(false)}><X size={17} /></button></div><p>只改变你的画面，设置会保存在当前浏览器。</p><label className="preference-range">字号<span>{preferences.size}px</span><input aria-label="弹幕字号" type="range" min="16" max="32" step="1" value={preferences.size} onChange={event => updatePreferences({ ...preferences, size: Number(event.target.value) })} /></label><label className="preference-range">透明度<span>{Math.round(preferences.opacity * 100)}%</span><input aria-label="弹幕透明度" type="range" min="0.25" max="1" step="0.05" value={preferences.opacity} onChange={event => updatePreferences({ ...preferences, opacity: Number(event.target.value) })} /></label><label className="preference-range">停留时间<span>{preferences.duration}秒</span><input aria-label="弹幕停留时间" type="range" min="5" max="14" step="1" value={preferences.duration} onChange={event => updatePreferences({ ...preferences, duration: Number(event.target.value) })} /></label><fieldset className="preference-options"><legend>显示区域</legend>{([{ value: 'top', label: '画面上方' }, { value: 'full', label: '整个画面' }] as const).map(area => <button type="button" aria-pressed={preferences.area === area.value} key={area.value} onClick={() => updatePreferences({ ...preferences, area: area.value })}>{area.label}</button>)}</fieldset><fieldset className="preference-options preference-colors"><legend>文字颜色</legend>{danmakuColors.map(color => <button type="button" aria-label={color.label} aria-pressed={preferences.color === color.value} key={color.value} style={{ '--swatch': color.value } as CSSProperties} onClick={() => updatePreferences({ ...preferences, color: color.value })}><i />{color.label}</button>)}</fieldset><div className="preference-footer"><button type="button" onClick={() => { setDanmaku(value => !value); reveal(); }}>{danmaku ? '关闭弹幕' : '开启弹幕'}</button><button type="button" onClick={() => updatePreferences({ ...defaultDanmaku })}>恢复默认</button></div></section>}
    {voiceControls && <div className="immersive-voice-controls" data-voice-controls>{voiceControls}</div>}
  </div>;
}

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Headphones, Mic, MicOff, Phone, PhoneOff, Radio, Volume2 } from 'lucide-react';
import type { Voice } from './useVoice';
import './voice.css';

function voiceDescription(voice: Voice) {
  if (!voice.available) return '房间连接后，可与朋友开启语音。';
  if (!voice.enabled) return voice.mode === 'ptt' ? '开启后可收听，按住时才使用麦克风。' : '双方开启语音后，呼叫朋友。';
  if (voice.status === 'starting') return '正在连接语音…';
  if (!voice.authenticated) return voice.status === 'authenticating' ? '正在确认朋友的语音连接…' : '等朋友也开启语音。';
  if (voice.friendMode !== voice.mode) return `朋友正在使用${voice.friendMode === 'ptt' ? '对讲' : '连麦'}，选择相同模式后即可说话。`;
  if (voice.mode === 'ptt') {
    if (voice.talking) return '正在说话，松开即停。';
    if (voice.holding) return '正在准备麦克风与连接，松开即可取消。';
    return voice.listening ? '朋友正在说话。' : '可以收听；按住按钮，或按住空格 / 回车说话。';
  }
  if (voice.phase === 'incoming') return '朋友邀请你连麦，接听后才会开启麦克风。';
  if (voice.phase === 'calling') return '正在呼叫朋友…';
  if (voice.phase === 'connecting') return '正在接通语音…';
  if (voice.phase === 'active') return voice.muted ? '麦克风已静音，仍可收听朋友。' : '连麦中，和朋友轻声聊聊。';
  return '朋友已就绪，可以发起呼叫。';
}

export function VoicePanel({ voice, compact = false }: { voice: Voice; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const open = !compact || expanded || voice.phase === 'incoming' || voice.audioBlocked || !!voice.error;
  const gesture = useRef<{ pointer?: number; key?: string; element: HTMLButtonElement } | null>(null);
  const stopTalking = voice.stopTalking;
  const release = () => {
    const held = gesture.current;
    if (!held) return;
    gesture.current = null;
    stopTalking();
    if (held.pointer !== undefined && held.element.hasPointerCapture(held.pointer)) held.element.releasePointerCapture(held.pointer);
  };
  useEffect(() => {
    const blur = () => {
      const held = gesture.current;
      if (!held) return;
      gesture.current = null;
      stopTalking();
      if (held.pointer !== undefined && held.element.hasPointerCapture(held.pointer)) held.element.releasePointerCapture(held.pointer);
    };
    const visibility = () => { if (document.visibilityState !== 'visible') blur(); };
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      blur();
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [stopTalking]);
  const ready = voice.enabled && voice.authenticated && voice.friendMode === voice.mode;
  useEffect(() => {
    if ((!ready || !voice.holding) && gesture.current) {
      const held = gesture.current;
      gesture.current = null;
      stopTalking();
      if (held.pointer !== undefined && held.element.hasPointerCapture(held.pointer)) held.element.releasePointerCapture(held.pointer);
    }
  }, [ready, voice.holding, stopTalking]);
  const pointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (!ready || event.button !== 0 || gesture.current) return;
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointer: event.pointerId, element: event.currentTarget };
    voice.startTalking();
  };
  const pointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault(); event.stopPropagation();
    if (gesture.current?.pointer === event.pointerId) release();
  };
  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (!ready || event.repeat || gesture.current) return;
    gesture.current = { key: event.key, element: event.currentTarget };
    voice.startTalking();
  };
  const keyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    if (gesture.current?.key === event.key) release();
  };
  const speaking = voice.mode === 'ptt' && voice.talking;
  return <section className={`voice-panel${compact ? ' voice-panel-compact' : ''}${!open ? ' voice-panel-collapsed' : ''}${speaking ? ' voice-panel-speaking' : ''}`}  aria-label="双人语音" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    {compact && <div className="voice-toggle-row"><button type="button" className="voice-toggle" aria-label={open ? '收起语音控制' : '展开语音控制'} aria-expanded={open} disabled={voice.holding} onClick={() => setExpanded(value => !value)}><Headphones size={16} aria-hidden="true" /><span>{voice.enabled ? voice.mode === 'ptt' ? '对讲' : voice.phase === 'active' ? '连麦中' : '语音已开启' : '语音'}</span><span className="voice-toggle-hint">{open ? '收起' : '设置'}</span></button></div>}
    <div className="voice-details" hidden={!open}>
    <div className="voice-heading"><h2><Headphones size={17} aria-hidden="true" />一起说说话</h2><span className={`voice-presence${voice.authenticated ? ' voice-presence-ready' : ''}`}>{voice.enabled ? voice.authenticated ? '已连接' : '等待连接' : '未开启'}</span></div>
    <div className="voice-toolbar">
      <div className="voice-modes" role="group" aria-label="语音模式">
        <button type="button" aria-pressed={voice.mode === 'call'} onClick={() => { release(); voice.setMode('call'); }}><Phone size={14} aria-hidden="true" />连麦</button>
        <button type="button" aria-pressed={voice.mode === 'ptt'} onClick={() => { release(); voice.setMode('ptt'); }}><Radio size={14} aria-hidden="true" />对讲</button>
      </div>
      {voice.enabled ? <button type="button" className="voice-action voice-action-quiet" onClick={() => { release(); voice.disable(); }}>关闭语音</button> : <button type="button" className="voice-action voice-action-primary" disabled={!voice.available} onClick={voice.enable}>开启语音</button>}
    </div>
    <p className="voice-description" role="status" aria-live="polite">{voiceDescription(voice)}</p>
    {voice.enabled && voice.mode === 'call' && <div className="voice-call-actions">
      {voice.phase === 'idle' && <button type="button" className="voice-action voice-action-primary" disabled={!ready} onClick={voice.call}><Phone size={15} aria-hidden="true" />呼叫朋友</button>}
      {voice.phase === 'incoming' && <><button type="button" className="voice-action voice-action-primary" onClick={voice.accept}><Phone size={15} aria-hidden="true" />接听</button><button type="button" className="voice-action voice-action-quiet" onClick={voice.reject}>拒绝</button></>}
      {voice.phase === 'active' && <button type="button" className="voice-action voice-action-quiet" aria-pressed={voice.muted} onClick={voice.toggleMute}>{voice.muted ? <MicOff size={15} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}{voice.muted ? '取消静音' : '静音'}</button>}
      {voice.phase !== 'idle' && voice.phase !== 'incoming' && <button type="button" className="voice-action voice-action-end" onClick={voice.hangUp}><PhoneOff size={15} aria-hidden="true" />{voice.phase === 'calling' ? '取消呼叫' : '挂断'}</button>}
    </div>}
    </div>
    {voice.enabled && voice.mode === 'ptt' && <button type="button" className={`voice-hold${voice.holding ? ' voice-hold-active' : ''}`} disabled={!ready} aria-label="按住说话，松开停止" aria-pressed={voice.holding} onPointerDown={pointerDown} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} onLostPointerCapture={pointerEnd} onBlur={release} onKeyDown={keyDown} onKeyUp={keyUp} onContextMenu={event => event.preventDefault()}><Mic size={18} aria-hidden="true" /><span>{voice.talking ? '松开结束' : voice.holding ? '正在准备…' : '按住说话'}</span></button>}
    {voice.audioBlocked && <div className="voice-audio-prompt" role="alert"><span>浏览器暂停了语音播放。</span><button type="button" className="voice-action voice-action-primary" onClick={() => void voice.resumeAudio()}><Volume2 size={15} aria-hidden="true" />点击开启收听</button></div>}
    {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
  </section>;
}

export default VoicePanel;

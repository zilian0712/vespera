import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { VoiceController, type VoiceOptions } from './voice';

export function useVoice(options: VoiceOptions) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const playback = useRef(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const ensureAudio = useCallback(() => {
    if (!audio.current) {
      const element = new Audio();
      element.autoplay = false;
      element.setAttribute('playsinline', '');
      audio.current = element;
    }
    return audio.current;
  }, []);
  const playAudio = useCallback(async () => {
    const element = audio.current;
    if (!element?.srcObject) return;
    const stream = element.srcObject;
    const attempt = ++playback.current;
    try {
      await element.play();
      if (attempt === playback.current && element.srcObject === stream) setAudioBlocked(false);
    } catch {
      if (attempt === playback.current && element.srcObject === stream) setAudioBlocked(true);
    }
  }, []);
  const [controller] = useState(() => new VoiceController(options, {
    onRemoteStream(stream) {
      const element = audio.current;
      ++playback.current;
      if (!element) return;
      element.pause();
      element.srcObject = stream;
      setAudioBlocked(false);
      if (stream) void playAudio();
    },
  }));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.update(options);
  }, [controller, options.roomId, options.token, options.clientId, options.friendId, options.connected]);
  useEffect(() => {
    const blur = () => controller.suspend();
    const visibility = () => { if (document.visibilityState !== 'visible') controller.suspend(); };
    window.addEventListener('blur', blur);
    window.addEventListener('pagehide', controller.disable);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', blur);
      window.removeEventListener('pagehide', controller.disable);
      document.removeEventListener('visibilitychange', visibility);
      controller.disable();
      ++playback.current;
      audio.current?.pause();
      if (audio.current) audio.current.srcObject = null;
      audio.current = null;
    };
  }, [controller]);
  const enable = useCallback(() => {
    ensureAudio();
    void controller.enable();
  }, [controller, ensureAudio]);
  return {
    ...state, audioBlocked, enable, disable: controller.disable, setMode: controller.setMode,
    call: controller.call, accept: controller.accept, reject: controller.reject,
    hangUp: controller.hangUp, toggleMute: controller.toggleMute,
    startTalking: controller.startTalking, stopTalking: controller.stopTalking, resumeAudio: playAudio,
  };
}

export type Voice = ReturnType<typeof useVoice>;
export type { VoiceOptions, VoiceMode } from './voice';

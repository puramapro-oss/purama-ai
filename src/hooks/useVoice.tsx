import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  transcribeAudio,
  synthesizeSpeech,
  browserSpeak,
  stopBrowserSpeak,
  getVoiceSettings,
  saveVoiceSettings,
  DEFAULT_VOICE_SETTINGS,
  type VoiceSettings,
} from '@/lib/voice';
import { useAuth } from '@/hooks/useAuth';
import { createRequestScope, type RequestLease } from '@/lib/request-scope';

export interface UseVoice {
  isRecording: boolean;
  isTranscribing: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => void;
  audioLevel: number;
  isSpeaking: boolean;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => Promise<void>;
  loadingSettings: boolean;
}

export function useVoice(): UseVoice {
  const { user } = useAuth();
  const userId = user?.id;
  const [operations] = useState(createRequestScope);
  const mountedRef = useRef(false);
  const [settings, setSettings] = useState<VoiceSettings>({ ...DEFAULT_VOICE_SETTINGS });
  const [loadingSettings, setLoadingSettings] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordingLeaseRef = useRef<RequestLease | null>(null);
  const pendingStopRef = useRef<((text: string | null) => void) | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const browserPlaybackRef = useRef(false);

  const startLevelMonitor = useCallback((stream: MediaStream) => {
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current || !mountedRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        setAudioLevel(Math.min(1, (sum / data.length / 255) * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('[useVoice] level monitor failed', e);
    }
  }, []);

  const stopLevelMonitor = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    if (mountedRef.current) setAudioLevel(0);
  }, []);

  const teardownRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    stopLevelMonitor();
    if (mountedRef.current) setIsRecording(false);
  }, [stopLevelMonitor]);

  const cancelRecording = useCallback(() => {
    // This also invalidates a permission prompt or transcription still in flight.
    operations.cancel('recording');
    recordingLeaseRef.current = null;
    pendingStopRef.current?.(null);
    pendingStopRef.current = null;
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      recorder.ondataavailable = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') {
        try { recorder.stop(); } catch { /* already stopped */ }
      }
    }
    chunksRef.current = [];
    teardownRecording();
    if (mountedRef.current) setIsTranscribing(false);
  }, [operations, teardownRecording]);

  const startRecording = useCallback(async () => {
    if (!mountedRef.current || !settings.enabled) return;
    const lease = operations.begin('recording');
    if (!lease) return;
    recordingLeaseRef.current = lease;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!lease.current() || !mountedRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = e => {
        if (lease.current() && e.data?.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = () => { if (lease.current()) cancelRecording(); };
      recorder.start();
      setIsRecording(true);
      startLevelMonitor(stream);
    } catch (e) {
      if (!lease.current()) return;
      lease.finish();
      recordingLeaseRef.current = null;
      teardownRecording();
      throw e;
    }
  }, [operations, settings.enabled, cancelRecording, startLevelMonitor, teardownRecording]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current;
    const lease = recordingLeaseRef.current;
    if (!recorder || !lease?.current() || recorder.state !== 'recording') return null;
    return new Promise<string | null>((resolve) => {
      let settled = false;
      const finish = (text: string | null) => {
        if (settled) return;
        settled = true;
        lease.signal.removeEventListener('abort', onAbort);
        if (pendingStopRef.current === finish) pendingStopRef.current = null;
        if (recordingLeaseRef.current === lease) recordingLeaseRef.current = null;
        if (lease.current()) {
          lease.finish();
          if (mountedRef.current) setIsTranscribing(false);
        }
        resolve(text);
      };
      const onAbort = () => finish(null);
      lease.signal.addEventListener('abort', onAbort, { once: true });
      pendingStopRef.current = finish;
      recorder.onstop = async () => {
        if (!lease.current() || !mountedRef.current) { finish(null); return; }
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        teardownRecording();
        if (blob.size < 200) { finish(null); return; }
        setIsTranscribing(true);
        try {
          const text = await transcribeAudio(blob, settings.language, lease.signal);
          finish(lease.current() && mountedRef.current ? text : null);
        } catch {
          finish(null);
        }
      };
      try { recorder.stop(); } catch { teardownRecording(); finish(null); }
    });
  }, [settings.language, teardownRecording]);

  const releasePlayback = useCallback(() => {
    const audio = audioElRef.current;
    audioElRef.current = null;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = '';
    }
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    if (speechWatchRef.current !== null) clearInterval(speechWatchRef.current);
    speechWatchRef.current = null;
    // Another mounted voice control may own the browser's global speech queue.
    if (browserPlaybackRef.current) stopBrowserSpeak();
    browserPlaybackRef.current = false;
  }, []);

  const stopSpeaking = useCallback(() => {
    operations.cancel('speech');
    releasePlayback();
    if (mountedRef.current) setIsSpeaking(false);
  }, [operations, releasePlayback]);

  const speak = useCallback(async (text: string) => {
    stopSpeaking();
    if (!mountedRef.current || !settings.enabled || !text?.trim()) return;
    const lease = operations.begin('speech');
    if (!lease) return;
    setIsSpeaking(true);
    try {
      const blob = await synthesizeSpeech(text, {
        provider: settings.provider, voice_id: settings.voice_id, speed: settings.speed,
      }, lease.signal);
      // A late TTS response must never resume playback after Stop or a newer request.
      if (!lease.current() || !mountedRef.current) return;
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioUrlRef.current = url;
        audioElRef.current = audio;
        audio.onended = () => { if (lease.current()) stopSpeaking(); };
        audio.onerror = () => { if (lease.current()) stopSpeaking(); };
        await audio.play();
        return;
      }
    } catch (e) {
      if (!lease.current() || !mountedRef.current) return;
      releasePlayback();
      console.warn('[useVoice] TTS failed, falling back', e);
    }
    if (!lease.current() || !mountedRef.current) return;
    const ok = browserSpeak(text, settings.language === 'fr' ? 'fr-FR' : settings.language);
    browserPlaybackRef.current = ok;
    if (!ok) { stopSpeaking(); return; }
    speechWatchRef.current = setInterval(() => {
      if (lease.current() && !window.speechSynthesis.speaking) stopSpeaking();
    }, 250);
  }, [operations, settings, stopSpeaking, releasePlayback]);

  // Revoke operations before paint on account changes and on unmount.
  useLayoutEffect(() => {
    mountedRef.current = true;
    cancelRecording();
    stopSpeaking();
    setSettings({ ...DEFAULT_VOICE_SETTINGS });
    setLoadingSettings(Boolean(userId));
    return () => {
      mountedRef.current = false;
      operations.invalidate();
      cancelRecording();
      stopSpeaking();
    };
  }, [operations, cancelRecording, stopSpeaking, userId]);

  useEffect(() => {
    if (!userId) return;
    operations.cancel('settings');
    const lease = operations.begin('settings');
    if (!lease) return;
    getVoiceSettings(userId)
      .then(next => { if (lease.current()) setSettings(next); })
      .catch(() => {})
      .finally(() => { if (lease.current()) { setLoadingSettings(false); lease.finish(); } });
    return () => operations.cancel('settings');
  }, [operations, userId]);

  const updateSettings = useCallback(async (patch: Partial<VoiceSettings>) => {
    if (!mountedRef.current) return;
    operations.cancel('settings');
    if (!userId) {
      setSettings(prev => ({ ...prev, ...patch }));
      setLoadingSettings(false);
      return;
    }
    const lease = operations.begin('settings');
    if (!lease) return;
    try {
      const next = await saveVoiceSettings(userId, patch);
      if (lease.current()) setSettings(next);
    } finally {
      if (lease.current()) { setLoadingSettings(false); lease.finish(); }
    }
  }, [operations, userId]);

  useEffect(() => {
    if (!settings.enabled) { cancelRecording(); stopSpeaking(); }
  }, [settings.enabled, cancelRecording, stopSpeaking]);

  return {
    isRecording, isTranscribing, startRecording, stopRecording, cancelRecording, audioLevel,
    isSpeaking, speak, stopSpeaking, settings, updateSettings, loadingSettings,
  };
}

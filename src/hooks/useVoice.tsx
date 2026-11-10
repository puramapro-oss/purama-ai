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
import { useRequestScope } from '@/hooks/useRequestScope';

export interface UseVoice {
  // Recording / STT
  isRecording: boolean;
  isTranscribing: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => void;
  audioLevel: number; // 0..1 for waveform
  // TTS
  isSpeaking: boolean;
  speak: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  // Settings
  settings: VoiceSettings;
  updateSettings: (patch: Partial<VoiceSettings>) => Promise<void>;
  loadingSettings: boolean;
}

export function useVoice(): UseVoice {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const scopeKey = JSON.stringify([userId]);
  const captureScope = useRequestScope(scopeKey);
  const [loadedSettings, setLoadedSettings] = useState<{ key: string; value: VoiceSettings } | null>(null);
  const settings = loadedSettings?.key === scopeKey ? loadedSettings.value : DEFAULT_VOICE_SETTINGS;
  const loadingSettings = Boolean(userId) && loadedSettings?.key !== scopeKey;
  const settingsRevisionRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const speechWatchRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechRequestRef = useRef(0);
  const recordingRequestRef = useRef(0);
  const recordingPendingRef = useRef(false);
  const stopPromiseRef = useRef<Promise<string | null> | null>(null);
  const finishRecordingRef = useRef<((value: string | null) => void) | null>(null);

  useEffect(() => {
    if (!userId) return;
    const isCurrent = captureScope();
    const revision = settingsRevisionRef.current;
    getVoiceSettings(userId)
      .then(value => {
        if (isCurrent() && revision === settingsRevisionRef.current) {
          setLoadedSettings({ key: scopeKey, value });
        }
      })
      .catch(() => {
        if (isCurrent() && revision === settingsRevisionRef.current) {
          setLoadedSettings({ key: scopeKey, value: { ...DEFAULT_VOICE_SETTINGS } });
        }
      });
  }, [userId, scopeKey, captureScope]);

  const updateSettings = useCallback(async (patch: Partial<VoiceSettings>) => {
    const isCurrent = captureScope();
    if (!isCurrent()) return;
    const changes = { ...patch };
    if (!userId) {
      setLoadedSettings(previous => ({
        key: scopeKey,
        value: { ...(previous?.key === scopeKey ? previous.value : DEFAULT_VOICE_SETTINGS), ...changes },
      }));
      return;
    }
    // Preserve local write order, and never start a queued request after its owner left.
    const operation = saveQueueRef.current.then(async () => {
      if (!isCurrent()) return;
      try {
        const value = await saveVoiceSettings(userId, changes);
        if (!isCurrent()) return;
        settingsRevisionRef.current += 1;
        setLoadedSettings({ key: scopeKey, value });
      } catch (error) {
        if (isCurrent()) throw error;
      }
    });
    saveQueueRef.current = operation.catch(() => {});
    await operation;
  }, [userId, scopeKey, captureScope]);

  // ---------- Audio level monitoring (waveform) ----------
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
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / data.length / 255;
        setAudioLevel(Math.min(1, avg * 2.2));
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      console.warn('[useVoice] level monitor failed', e);
    }
  }, []);

  const stopLevelMonitor = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    analyserRef.current?.disconnect();
    analyserRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setAudioLevel(0);
  }, []);

  // ---------- Recording ----------
  const startRecording = useCallback(async () => {
    const isCurrent = captureScope();
    if (!isCurrent() || isRecording || recorderRef.current || recordingPendingRef.current || stopPromiseRef.current) return;
    const request = ++recordingRequestRef.current;
    recordingPendingRef.current = true;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent() || request !== recordingRequestRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = event => {
        if (isCurrent() && request === recordingRequestRef.current && event.data?.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
      startLevelMonitor(stream);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      if (streamRef.current === stream) streamRef.current = null;
      if (isCurrent() && request === recordingRequestRef.current) throw error;
    } finally {
      if (request === recordingRequestRef.current) recordingPendingRef.current = false;
    }
  }, [captureScope, isRecording, startLevelMonitor]);

  const teardownRecording = useCallback((recorder?: MediaRecorder) => {
    if (recorder && recorderRef.current !== recorder) return;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    stopLevelMonitor();
    setIsRecording(false);
  }, [stopLevelMonitor]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    const recorder = recorderRef.current;
    const isCurrent = captureScope();
    const request = recordingRequestRef.current;
    if (!recorder || !isCurrent()) return null;
    const current = () => isCurrent() && request === recordingRequestRef.current;
    const pending = new Promise<string | null>(resolve => {
      const finish = (value: string | null) => {
        if (finishRecordingRef.current === finish) {
          finishRecordingRef.current = null;
          stopPromiseRef.current = null;
        }
        resolve(value);
      };
      finishRecordingRef.current = finish;
      recorder.onstop = async () => {
        if (!current()) { finish(null); return; }
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        teardownRecording(recorder);
        if (blob.size < 200) { finish(null); return; }
        setIsTranscribing(true);
        try {
          const text = await transcribeAudio(blob, settings.language);
          finish(current() ? text : null);
        } catch {
          finish(null);
        } finally {
          if (current()) setIsTranscribing(false);
        }
      };
    });
    stopPromiseRef.current = pending;
    try { recorder.stop(); } catch { teardownRecording(recorder); finishRecordingRef.current?.(null); }
    return pending;
  }, [captureScope, settings.language, teardownRecording]);

  const cancelRecording = useCallback(() => {
    recordingRequestRef.current += 1;
    recordingPendingRef.current = false;
    finishRecordingRef.current?.(null);
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.onstop = null;
      try { recorder.stop(); } catch { /* already stopped */ }
    }
    teardownRecording();
    setIsTranscribing(false);
  }, [teardownRecording]);

  // ---------- TTS ----------
  const releaseAudio = useCallback(() => {
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
  }, []);

  const stopSpeaking = useCallback(() => {
    speechRequestRef.current += 1;
    releaseAudio();
    if (speechWatchRef.current !== null) clearInterval(speechWatchRef.current);
    speechWatchRef.current = null;
    stopBrowserSpeak();
    setIsSpeaking(false);
  }, [releaseAudio]);

  const speak = useCallback(async (text: string) => {
    const inScope = captureScope();
    if (!inScope()) return;
    stopSpeaking();
    if (!text || !text.trim()) return;
    const request = speechRequestRef.current;
    const current = () => inScope() && request === speechRequestRef.current;
    setIsSpeaking(true);
    try {
      const blob = await synthesizeSpeech(text, {
        provider: settings.provider, voice_id: settings.voice_id, speed: settings.speed,
      });
      if (!current()) return;
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioElRef.current = audio;
        audio.onended = () => { if (current()) stopSpeaking(); };
        audio.onerror = () => { if (current()) stopSpeaking(); };
        await audio.play();
        return;
      }
    } catch {
      if (!current()) return;
      releaseAudio();
    }
    if (!current()) return;
    const ok = browserSpeak(text, settings.language === 'fr' ? 'fr-FR' : settings.language);
    if (!ok) { setIsSpeaking(false); return; }
    speechWatchRef.current = setInterval(() => {
      if (!current() || !window.speechSynthesis.speaking) stopSpeaking();
    }, 250);
  }, [captureScope, settings, stopSpeaking, releaseAudio]);

  // A changed identity and unmount both invalidate work before the next paint.
  useLayoutEffect(() => {
    saveQueueRef.current = Promise.resolve();
    return () => {
      cancelRecording();
      stopSpeaking();
    };
  }, [scopeKey, cancelRecording, stopSpeaking]);

  return {
    isRecording, isTranscribing, startRecording, stopRecording, cancelRecording, audioLevel,
    isSpeaking, speak, stopSpeaking, settings, updateSettings, loadingSettings,
  };
}

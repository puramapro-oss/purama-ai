import { useCallback, useEffect, useRef, useState } from 'react';
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
  const [settings, setSettings] = useState<VoiceSettings>({ ...DEFAULT_VOICE_SETTINGS });
  const [loadingSettings, setLoadingSettings] = useState(true);

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

  // Load settings
  useEffect(() => {
    if (!user) {
      setLoadingSettings(false);
      return;
    }
    let cancelled = false;
    getVoiceSettings(user.id)
      .then(s => { if (!cancelled) setSettings(s); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingSettings(false); });
    return () => { cancelled = true; };
  }, [user?.id]);

  const updateSettings = useCallback(async (patch: Partial<VoiceSettings>) => {
    if (!user) {
      setSettings(prev => ({ ...prev, ...patch }));
      return;
    }
    const next = await saveVoiceSettings(user.id, patch);
    setSettings(next);
  }, [user?.id]);

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
    if (isRecording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
      startLevelMonitor(stream);
    } catch (e) {
      console.error('[useVoice] mic denied', e);
      throw e;
    }
  }, [isRecording, startLevelMonitor]);

  const teardownRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    stopLevelMonitor();
    setIsRecording(false);
  }, [stopLevelMonitor]);

  const stopRecording = useCallback(async (): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    return new Promise<string | null>((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        teardownRecording();
        if (blob.size < 200) {
          resolve(null);
          return;
        }
        setIsTranscribing(true);
        try {
          const text = await transcribeAudio(blob, settings.language);
          resolve(text);
        } catch (e) {
          console.error('[useVoice] transcribe failed', e);
          resolve(null);
        } finally {
          setIsTranscribing(false);
        }
      };
      try { recorder.stop(); } catch { teardownRecording(); resolve(null); }
    });
  }, [settings.language, teardownRecording]);

  const cancelRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    recorder.onstop = null;
    try { recorder.stop(); } catch { /* noop */ }
    teardownRecording();
  }, [teardownRecording]);

  // ---------- TTS ----------
  const stopSpeaking = useCallback(() => {
    audioElRef.current?.pause();
    if (audioElRef.current) {
      audioElRef.current.src = '';
      audioElRef.current = null;
    }
    stopBrowserSpeak();
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(async (text: string) => {
    stopSpeaking();
    if (!text || !text.trim()) return;
    setIsSpeaking(true);
    try {
      const blob = await synthesizeSpeech(text, {
        provider: settings.provider,
        voice_id: settings.voice_id,
        speed: settings.speed,
      });
      if (blob && blob.size > 0) {
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioElRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setIsSpeaking(false);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          setIsSpeaking(false);
        };
        await audio.play();
        return;
      }
    } catch (e) {
      console.warn('[useVoice] TTS failed, falling back', e);
    }
    // Fallback to browser SpeechSynthesis
    const ok = browserSpeak(text, settings.language === 'fr' ? 'fr-FR' : settings.language);
    if (!ok) setIsSpeaking(false);
    else {
      // Watch for end
      const watch = setInterval(() => {
        if (typeof window !== 'undefined' && !window.speechSynthesis.speaking) {
          clearInterval(watch);
          setIsSpeaking(false);
        }
      }, 250);
    }
  }, [settings, stopSpeaking]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelRecording();
      stopSpeaking();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    isRecording,
    isTranscribing,
    startRecording,
    stopRecording,
    cancelRecording,
    audioLevel,
    isSpeaking,
    speak,
    stopSpeaking,
    settings,
    updateSettings,
    loadingSettings,
  };
}

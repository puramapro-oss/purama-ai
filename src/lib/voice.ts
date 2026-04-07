// Voice utilities — STT (Whisper / Web Speech API), TTS (OpenAI / ElevenLabs / SpeechSynthesis)
import { supabase } from '@/integrations/supabase/client';

export interface VoiceSettings {
  user_id?: string;
  provider: 'openai' | 'elevenlabs';
  voice_id: string;
  speed: number;
  auto_play: boolean;
  enabled: boolean;
  language: string;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'openai',
  voice_id: 'nova',
  speed: 1.0,
  auto_play: false,
  enabled: true,
  language: 'fr',
};

export const OPENAI_VOICES = [
  { id: 'alloy', label: 'Alloy — neutre, équilibrée' },
  { id: 'echo', label: 'Echo — masculine, calme' },
  { id: 'fable', label: 'Fable — chaleureuse' },
  { id: 'onyx', label: 'Onyx — masculine, grave' },
  { id: 'nova', label: 'Nova — féminine, énergique' },
  { id: 'shimmer', label: 'Shimmer — féminine, douce' },
];

export const ELEVENLABS_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — neutre' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi — énergique' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — douce' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni — masculine' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold — grave' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — narratif' },
];

// =============================================================
// Settings persistence
// =============================================================
type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

export async function getVoiceSettings(userId: string): Promise<VoiceSettings> {
  const { data, error } = await sb()
    .from('voice_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { ...DEFAULT_VOICE_SETTINGS };
  return {
    user_id: data.user_id,
    provider: data.provider,
    voice_id: data.voice_id,
    speed: Number(data.speed),
    auto_play: data.auto_play,
    enabled: data.enabled,
    language: data.language,
  };
}

export async function saveVoiceSettings(userId: string, patch: Partial<VoiceSettings>): Promise<VoiceSettings> {
  const current = await getVoiceSettings(userId);
  const next = { ...current, ...patch, user_id: userId, updated_at: new Date().toISOString() };
  const { data, error } = await sb()
    .from('voice_settings')
    .upsert(next, { onConflict: 'user_id' })
    .select()
    .single();
  if (error) throw error;
  return {
    user_id: data.user_id,
    provider: data.provider,
    voice_id: data.voice_id,
    speed: Number(data.speed),
    auto_play: data.auto_play,
    enabled: data.enabled,
    language: data.language,
  };
}

// =============================================================
// STT — Speech to Text
// =============================================================
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

export async function transcribeAudio(blob: Blob, language = 'fr'): Promise<string> {
  const base64 = await blobToBase64(blob);
  const { data, error } = await supabase.functions.invoke('voice-transcribe', {
    body: { audio: base64, mime: blob.type || 'audio/webm', lang: language },
  });
  if (error) throw error;
  const result = data as { text?: string; error?: string };
  if (result.error) throw new Error(result.error);
  return result.text ?? '';
}

// =============================================================
// TTS — Text to Speech
// =============================================================
export async function synthesizeSpeech(
  text: string,
  settings: Pick<VoiceSettings, 'provider' | 'voice_id' | 'speed'>,
): Promise<Blob | null> {
  // Strip markdown for cleaner narration
  const clean = text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 4000);
  if (!clean) return null;

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token;
    if (!token) return null;
    const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/voice-tts`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: clean,
        provider: settings.provider,
        voice: settings.voice_id,
        speed: settings.speed,
      }),
    });
    if (!r.ok) return null;
    return await r.blob();
  } catch {
    return null;
  }
}

// Browser SpeechSynthesis fallback
export function browserSpeak(text: string, lang = 'fr-FR'): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false;
  const clean = text.replace(/[*_`#>]/g, '').slice(0, 1500);
  if (!clean) return false;
  const utter = new SpeechSynthesisUtterance(clean);
  utter.lang = lang;
  utter.rate = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
  return true;
}

export function stopBrowserSpeak() {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
}

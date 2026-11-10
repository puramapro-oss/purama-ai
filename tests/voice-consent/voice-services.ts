import { harness } from './transport';
export type { VoiceSettings } from '../../src/lib/voice';
import type { VoiceSettings } from '../../src/lib/voice';

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  provider: 'openai', voice_id: 'nova', speed: 1, auto_play: false, enabled: true, language: 'fr',
};
export async function getVoiceSettings(userId: string) {
  return { ...DEFAULT_VOICE_SETTINGS, user_id: userId, auto_play: harness.autoPlay };
}
export async function saveVoiceSettings(userId: string, patch: Partial<VoiceSettings>) {
  return { ...await getVoiceSettings(userId), ...patch };
}
export function transcribeAudio() { return harness.defer('transcribe') as Promise<string>; }
export function synthesizeSpeech(text: string) { return harness.defer('synthesize', { text }) as Promise<Blob | null>; }
export function browserSpeak(text: string) {
  harness.browserSpoken.push(text);
  harness.browserSpeaking = true;
  return true;
}
export function stopBrowserSpeak() { harness.browserSpeaking = false; }

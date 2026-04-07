import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Mic2, Volume2, Loader2, Headphones, Play } from 'lucide-react';
import { toast } from 'sonner';
import { useVoice } from '@/hooks/useVoice';
import { OPENAI_VOICES, ELEVENLABS_VOICES } from '@/lib/voice';

export function VoiceSettingsCard() {
  const voice = useVoice();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const voices = voice.settings.provider === 'elevenlabs' ? ELEVENLABS_VOICES : OPENAI_VOICES;

  const update = async (patch: Parameters<typeof voice.updateSettings>[0]) => {
    setSaving(true);
    try {
      await voice.updateSettings(patch);
      toast.success('🎙️ Voix mise à jour');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  };

  const testVoice = async () => {
    setTesting(true);
    try {
      await voice.speak("Bonjour, je suis ton agent Purama. Tu peux me parler à voix haute, je t'écoute et je te réponds.");
    } finally {
      setTimeout(() => setTesting(false), 1500);
    }
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-6 space-y-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-purple/15 flex items-center justify-center">
            <Headphones className="w-5 h-5 text-accent-purple" />
          </div>
          <div className="flex-1">
            <h3 className="font-orbitron font-semibold text-foreground">Voix bidirectionnelle</h3>
            <p className="text-xs text-muted-foreground">
              Parle à tes agents et écoute leurs réponses comme une vraie conversation.
            </p>
          </div>
        </div>

        {voice.loadingSettings ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-5 h-5 animate-spin text-accent-purple" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Mic2 className="w-4 h-4 text-accent-cyan" /> Activer le mode vocal
                </p>
                <p className="text-[11px] text-muted-foreground">Affiche le bouton micro et le mode conversation vocale.</p>
              </div>
              <Switch
                checked={voice.settings.enabled}
                onCheckedChange={(v) => update({ enabled: v })}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground flex items-center gap-2">
                  <Volume2 className="w-4 h-4 text-emerald-400" /> Lecture automatique
                </p>
                <p className="text-[11px] text-muted-foreground">Lit la réponse de l'agent à voix haute automatiquement.</p>
              </div>
              <Switch
                checked={voice.settings.auto_play}
                onCheckedChange={(v) => update({ auto_play: v })}
                disabled={saving}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-border">
              <div>
                <Label className="text-xs">Fournisseur</Label>
                <Select
                  value={voice.settings.provider}
                  onValueChange={(v: 'openai' | 'elevenlabs') => update({ provider: v })}
                  disabled={saving}
                >
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI TTS (rapide, économique)</SelectItem>
                    <SelectItem value="elevenlabs">ElevenLabs (qualité studio)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Voix</Label>
                <Select
                  value={voice.settings.voice_id}
                  onValueChange={(v) => update({ voice_id: v })}
                  disabled={saving}
                >
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {voices.map(v => (
                      <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs">Vitesse · {voice.settings.speed.toFixed(2)}×</Label>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={voice.settings.speed}
                onChange={(e) => update({ speed: parseFloat(e.target.value) })}
                disabled={saving}
                className="w-full mt-2 accent-purple-500"
              />
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={testVoice}
              disabled={testing || voice.isSpeaking}
              className="w-full border-accent-purple/40 text-accent-purple hover:bg-accent-purple/10"
            >
              {voice.isSpeaking || testing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Tester la voix
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

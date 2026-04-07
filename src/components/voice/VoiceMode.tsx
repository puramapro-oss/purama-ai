import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mic, MicOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UseVoice } from '@/hooks/useVoice';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
  voice: UseVoice;
  agentName: string;
  agentEmoji?: string;
  agentColor?: string;
  /** Send the transcribed text and return the assistant reply */
  onSend: (text: string) => Promise<string | null>;
}

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * Fullscreen bidirectional voice conversation mode.
 * - Tap-to-talk OR continuous listening (auto turn-taking)
 * - Animated waveform reacts to mic OR TTS playback
 * - Live transcript + reply text shown
 */
export function VoiceMode({
  open,
  onClose,
  voice,
  agentName,
  agentEmoji = '🤖',
  agentColor = '#8B5CF6',
  onSend,
}: Props) {
  const {
    isRecording, isTranscribing, isSpeaking,
    startRecording, stopRecording, cancelRecording,
    audioLevel, speak, stopSpeaking,
  } = voice;

  const [phase, setPhase] = useState<Phase>('idle');
  const [userText, setUserText] = useState('');
  const [agentText, setAgentText] = useState('');
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  // Reset state when closing
  useEffect(() => {
    if (!open) {
      cancelRecording();
      stopSpeaking();
      setPhase('idle');
      setUserText('');
      setAgentText('');
    }
  }, [open, cancelRecording, stopSpeaking]);

  // Sync phase with hook state
  useEffect(() => {
    if (isRecording) setPhase('listening');
    else if (isTranscribing) setPhase('thinking');
    else if (isSpeaking) setPhase('speaking');
  }, [isRecording, isTranscribing, isSpeaking]);

  const handleMicTap = async () => {
    if (phase === 'speaking') {
      stopSpeaking();
      setPhase('idle');
      return;
    }
    if (phase === 'listening') {
      const text = await stopRecording();
      if (!text || !text.trim()) {
        setPhase('idle');
        return;
      }
      setUserText(text);
      setPhase('thinking');
      try {
        const reply = await onSend(text);
        if (reply) {
          setAgentText(reply);
          setPhase('speaking');
          await speak(reply);
        } else {
          setPhase('idle');
        }
      } catch (e) {
        toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
        setPhase('idle');
      }
      return;
    }
    // idle → start
    try {
      setUserText('');
      setAgentText('');
      await startRecording();
    } catch {
      toast.error('Micro indisponible', { description: "Autorise l'accès au microphone." });
    }
  };

  // Synthetic level when speaking (TTS) so the waveform stays alive
  const [synthLevel, setSynthLevel] = useState(0);
  useEffect(() => {
    if (phase !== 'speaking') {
      setSynthLevel(0);
      return;
    }
    let raf: number;
    const tick = () => {
      setSynthLevel(0.35 + Math.random() * 0.55);
      raf = requestAnimationFrame(() => setTimeout(tick, 80) as unknown as number);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  const liveLevel = phase === 'listening' ? audioLevel : phase === 'speaking' ? synthLevel : 0;

  // Build N bars for waveform
  const bars = 32;
  const barArray = Array.from({ length: bars }, (_, i) => i);

  if (typeof window === 'undefined') return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[10000] bg-background/95 backdrop-blur-2xl flex flex-col items-center justify-between py-10 px-6"
          style={{
            background: `radial-gradient(ellipse at center, ${agentColor}22 0%, rgba(10,10,15,0.95) 60%, rgba(10,10,15,1) 100%)`,
          }}
        >
          {/* Header */}
          <div className="w-full max-w-2xl flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl"
                style={{ background: `${agentColor}25`, border: `1px solid ${agentColor}55` }}
              >
                {agentEmoji}
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Mode vocal</p>
                <p className="text-lg font-semibold text-foreground">{agentName}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fermer le mode vocal"
              className="w-10 h-10 rounded-full border border-border bg-secondary/40 hover:bg-secondary/70 flex items-center justify-center text-muted-foreground hover:text-foreground transition"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Center: status + waveform */}
          <div className="flex flex-col items-center gap-8 flex-1 justify-center w-full max-w-2xl">
            <PhaseLabel phase={phase} agentName={agentName} />

            <Waveform bars={barArray} level={liveLevel} color={agentColor} active={phase !== 'idle'} />

            {/* Live transcripts */}
            <div className="w-full space-y-3 min-h-[120px]">
              {userText && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-right"
                >
                  <p className="text-[11px] text-muted-foreground uppercase mb-1">Toi</p>
                  <p className="text-sm text-foreground/90 italic">« {userText} »</p>
                </motion.div>
              )}
              {agentText && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <p className="text-[11px] uppercase mb-1" style={{ color: agentColor }}>{agentName}</p>
                  <p className="text-sm text-foreground/90 line-clamp-6">{agentText}</p>
                </motion.div>
              )}
            </div>
          </div>

          {/* Mic tap button */}
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleMicTap}
              disabled={phase === 'thinking'}
              aria-label="Activer/désactiver le micro"
              className={cn(
                'relative w-20 h-20 rounded-full flex items-center justify-center transition-all',
                'border-2 shadow-2xl',
                phase === 'listening' && 'bg-red-500/20 border-red-500/60 animate-pulse',
                phase === 'speaking' && 'bg-accent-purple/20 border-accent-purple/60',
                phase === 'thinking' && 'bg-secondary border-border',
                phase === 'idle' && 'bg-secondary/60 border-border hover:bg-secondary',
              )}
              style={phase === 'idle' ? { boxShadow: `0 0 40px ${agentColor}40` } : undefined}
            >
              {phase === 'thinking' ? (
                <Loader2 className="w-8 h-8 animate-spin text-accent-purple" />
              ) : phase === 'listening' ? (
                <MicOff className="w-8 h-8 text-red-400" />
              ) : (
                <Mic className="w-8 h-8" style={{ color: agentColor }} />
              )}
            </button>
            <p className="text-[11px] text-muted-foreground text-center">
              {phase === 'idle' && 'Appuie pour parler'}
              {phase === 'listening' && 'Appuie pour envoyer'}
              {phase === 'thinking' && 'Réflexion en cours…'}
              {phase === 'speaking' && 'Appuie pour interrompre'}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PhaseLabel({ phase, agentName }: { phase: Phase; agentName: string }) {
  const map: Record<Phase, string> = {
    idle: `Bonjour, je suis ${agentName}`,
    listening: 'Je t\'écoute…',
    thinking: 'Je réfléchis…',
    speaking: 'Je te réponds…',
  };
  return (
    <motion.p
      key={phase}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className="text-center text-xl font-light text-foreground/90"
    >
      {map[phase]}
    </motion.p>
  );
}

function Waveform({ bars, level, color, active }: { bars: number[]; level: number; color: string; active: boolean }) {
  return (
    <div className="flex items-center justify-center gap-1.5 h-32 w-full">
      {bars.map((i) => {
        // Each bar pulses with a phase offset for organic feel
        const phase = (i / bars.length) * Math.PI * 2;
        const pulse = active ? Math.abs(Math.sin(phase + Date.now() / 200)) : 0;
        const h = active
          ? Math.max(8, level * 100 * (0.4 + pulse * 0.6) + Math.random() * 20)
          : 8;
        return (
          <motion.span
            key={i}
            animate={{ height: h }}
            transition={{ type: 'spring', stiffness: 220, damping: 18 }}
            className="w-1.5 rounded-full"
            style={{
              background: `linear-gradient(180deg, ${color}, ${color}66)`,
              boxShadow: active ? `0 0 12px ${color}80` : undefined,
            }}
          />
        );
      })}
    </div>
  );
}

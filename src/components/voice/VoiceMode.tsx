import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Content as DialogContentPrimitive } from '@radix-ui/react-dialog';
import { X, Mic, MicOff, Loader2 } from 'lucide-react';
import { Dialog, DialogClose, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { UseVoice } from '@/hooks/useVoice';
import { useAuth } from '@/hooks/useAuth';
import { createRequestScope } from '@/lib/request-scope';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onClose: () => void;
  voice: UseVoice;
  agentName: string;
  agentEmoji?: string;
  agentColor?: string;
  /** Send the transcribed text and return the assistant reply */
  onSend: (text: string, signal?: AbortSignal) => Promise<string | null>;
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
  const { user } = useAuth();
  const [turns] = useState(createRequestScope);
  const reducedMotion = useReducedMotion();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const {
    isRecording, isTranscribing, isSpeaking,
    startRecording, stopRecording, cancelRecording,
    audioLevel, speak, stopSpeaking,
  } = voice;

  const [phase, setPhase] = useState<Phase>('idle');
  const [userText, setUserText] = useState('');
  const [agentText, setAgentText] = useState('');
  const [busyTurn, setBusyTurn] = useState(false);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  // Closing, switching accounts, or unmounting invalidates the whole voice turn.
  useLayoutEffect(() => {
    turns.invalidate();
    cancelRecording();
    stopSpeaking();
    setBusyTurn(false);
    setPhase('idle');
    setUserText('');
    setAgentText('');
    return () => {
      turns.invalidate();
      cancelRecording();
      stopSpeaking();
    };
  }, [open, user?.id, turns, cancelRecording, stopSpeaking]);

  const closeMode = useCallback(() => {
    // Do not wait for the parent to render open=false before honouring the close.
    turns.invalidate();
    cancelRecording();
    stopSpeaking();
    onClose();
  }, [turns, cancelRecording, stopSpeaking, onClose]);

  // Sync phase with hook state
  useEffect(() => {
    if (!open) return;
    if (isRecording) setPhase('listening');
    else if (isSpeaking) setPhase('speaking');
    else if (isTranscribing || busyTurn) setPhase('thinking');
    else setPhase('idle');
  }, [open, isRecording, isTranscribing, isSpeaking, busyTurn]);

  const handleMicTap = async () => {
    if (!open) return;
    if (phaseRef.current === 'speaking') {
      turns.invalidate();
      stopSpeaking();
      setBusyTurn(false);
      setPhase('idle');
      return;
    }
    if (phaseRef.current === 'thinking') return;
    const wasListening = phaseRef.current === 'listening';
    const lease = turns.begin('turn');
    if (!lease) return;
    setBusyTurn(true);
    try {
      if (!wasListening) {
        setUserText('');
        setAgentText('');
        await startRecording();
        return;
      }
      const text = await stopRecording();
      if (!lease.current() || !text?.trim()) return;
      setUserText(text);
      setPhase('thinking');
      const reply = await onSend(text, lease.signal);
      if (!lease.current() || !reply) return;
      setAgentText(reply);
      await speak(reply);
    } catch (e) {
      if (lease.current()) {
        toast.error(wasListening ? 'Erreur' : 'Micro indisponible', {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      if (lease.current()) { setBusyTurn(false); lease.finish(); }
    }
  };

  // Synthetic level when speaking (TTS) so the waveform stays alive
  const [synthLevel, setSynthLevel] = useState(0);
  useEffect(() => {
    if (phase !== 'speaking' || reducedMotion) {
      setSynthLevel(0);
      return;
    }
    const timer = setInterval(() => {
      setSynthLevel(0.35 + Math.random() * 0.55);
    }, 80);
    return () => clearInterval(timer);
  }, [phase, reducedMotion]);

  const liveLevel = phase === 'listening' ? audioLevel : phase === 'speaking' ? synthLevel : 0;

  // Build N bars for waveform
  const bars = 32;
  const barArray = Array.from({ length: bars }, (_, i) => i);

  if (typeof window === 'undefined') return null;

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) closeMode(); }}>
      <DialogPortal>
        <DialogOverlay className="z-[9999] motion-reduce:animate-none" />
        {/* Reuse the existing Radix modal engine, with this fullscreen layout and
            its single French close control instead of the shared panel styling. */}
        <DialogContentPrimitive
          aria-modal="true"
          onOpenAutoFocus={() => {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
          }}
          className="fixed inset-0 z-[10000] flex flex-col items-center gap-4 overflow-y-auto bg-background/95 px-4 py-4 backdrop-blur-2xl sm:px-6 sm:py-8"
          style={{
            background: `radial-gradient(ellipse at center, ${agentColor}22 0%, rgba(10,10,15,0.95) 60%, rgba(10,10,15,1) 100%)`,
          }}
        >
          {/* Header */}
          <div className="flex w-full max-w-2xl shrink-0 items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div
                aria-hidden="true"
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-2xl"
                style={{ background: `${agentColor}25`, border: `1px solid ${agentColor}55` }}
              >
                {agentEmoji}
              </div>
              <div className="min-w-0">
                <p aria-hidden="true" className="text-xs uppercase tracking-wider text-muted-foreground">Mode vocal</p>
                <DialogTitle className="break-words text-lg font-semibold text-foreground [overflow-wrap:anywhere]">
                  <span className="sr-only">Mode vocal avec </span>{agentName}
                </DialogTitle>
                <DialogDescription className="sr-only">
                  Active le micro pour parler. La transcription et la réponse restent consultables à l’écran.
                  Appuie sur Échap pour fermer.
                </DialogDescription>
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Fermer le mode vocal"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-secondary/40 text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
              >
                <X aria-hidden="true" className="w-5 h-5" />
              </button>
            </DialogClose>
          </div>

          {/* Center: status + waveform */}
          <div
            role="region"
            aria-label="Transcription et réponse"
            tabIndex={0}
            className="flex min-h-[8rem] w-full max-w-2xl flex-1 flex-col items-center gap-6 overflow-y-auto overscroll-contain rounded-lg px-1 py-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <PhaseLabel phase={phase} agentName={agentName} reducedMotion={!!reducedMotion} />

            <Waveform bars={barArray} level={liveLevel} color={agentColor} active={phase !== 'idle' && !reducedMotion} reducedMotion={!!reducedMotion} />

            {/* Live transcripts */}
            <div className="w-full shrink-0 space-y-3 min-h-[120px]">
              {userText && (
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reducedMotion ? { duration: 0 } : undefined}
                  className="text-right"
                >
                  <p className="text-[11px] text-muted-foreground uppercase mb-1">Toi</p>
                  <p className="whitespace-pre-wrap break-words text-sm italic text-foreground/90 [overflow-wrap:anywhere]">« {userText} »</p>
                </motion.div>
              )}
              {agentText && (
                <motion.div
                  initial={reducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={reducedMotion ? { duration: 0 } : undefined}
                >
                  <p className="text-[11px] uppercase mb-1" style={{ color: agentColor }}>{agentName}</p>
                  <p className="whitespace-pre-wrap break-words text-sm text-foreground/90 [overflow-wrap:anywhere]">{agentText}</p>
                </motion.div>
              )}
            </div>
          </div>

          {/* Mic tap button */}
          <div className="flex shrink-0 flex-col items-center gap-3">
            <button
              type="button"
              onClick={handleMicTap}
              disabled={phase === 'thinking'}
              aria-label={phase === 'listening' ? "Terminer l'enregistrement"
                : phase === 'speaking' ? 'Interrompre la réponse'
                  : phase === 'thinking' ? 'Traitement en cours'
                    : 'Activer le micro'}
              className={cn(
                'relative w-20 h-20 rounded-full flex items-center justify-center transition-all',
                'border-2 shadow-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:animate-none motion-reduce:transition-none',
                phase === 'listening' && 'bg-red-500/20 border-red-500/60 animate-pulse',
                phase === 'speaking' && 'bg-accent-purple/20 border-accent-purple/60',
                phase === 'thinking' && 'bg-secondary border-border',
                phase === 'idle' && 'bg-secondary/60 border-border hover:bg-secondary',
              )}
              style={phase === 'idle' ? { boxShadow: `0 0 40px ${agentColor}40` } : undefined}
            >
              {phase === 'thinking' ? (
                <Loader2 aria-hidden="true" className="w-8 h-8 animate-spin text-accent-purple motion-reduce:animate-none" />
              ) : phase === 'listening' ? (
                <MicOff aria-hidden="true" className="w-8 h-8 text-red-400" />
              ) : (
                <Mic aria-hidden="true" className="w-8 h-8" style={{ color: agentColor }} />
              )}
            </button>
            <p className="text-[11px] text-muted-foreground text-center">
              {phase === 'idle' && 'Appuie pour parler'}
              {phase === 'listening' && 'Appuie pour envoyer'}
              {phase === 'thinking' && 'Réflexion en cours…'}
              {phase === 'speaking' && 'Appuie pour interrompre'}
            </p>
          </div>
        </DialogContentPrimitive>
      </DialogPortal>
    </Dialog>
  );
}

function PhaseLabel({ phase, agentName, reducedMotion }: { phase: Phase; agentName: string; reducedMotion: boolean }) {
  const map: Record<Phase, string> = {
    idle: `Bonjour, je suis ${agentName}`,
    listening: 'Je t\'écoute…',
    thinking: 'Je réfléchis…',
    speaking: 'Je te réponds…',
  };
  return (
    <motion.p
      initial={reducedMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : undefined}
      role="status"
      className="shrink-0 text-center text-xl font-light text-foreground/90"
    >
      {map[phase]}
    </motion.p>
  );
}

function Waveform({ bars, level, color, active, reducedMotion }: { bars: number[]; level: number; color: string; active: boolean; reducedMotion: boolean }) {
  return (
    <div aria-hidden="true" className="flex h-32 w-full shrink-0 items-center justify-center gap-[3px] sm:gap-1.5">
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
            transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 220, damping: 18 }}
            className="min-w-0 max-w-[0.375rem] flex-1 rounded-full"
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

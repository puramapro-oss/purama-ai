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
          className="fixed inset-0 z-[10000] grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] justify-items-center gap-[8px] overflow-hidden bg-background/95 px-[12px] py-[12px] backdrop-blur-2xl sm:px-[24px] [@media_(min-width:640px)_and_(min-height:480px)]:gap-[16px] [@media_(min-width:640px)_and_(min-height:480px)]:py-[24px]"
          style={{
            background: `radial-gradient(ellipse at center, ${agentColor}22 0%, rgba(10,10,15,0.95) 60%, rgba(10,10,15,1) 100%)`,
          }}
        >
          {/* Header */}
          <div className="flex w-full max-w-2xl items-center justify-between gap-[8px]">
            <div className="min-w-0">
              <DialogTitle className="text-sm font-semibold text-foreground">
                Mode vocal<span className="sr-only"> avec {agentName}</span>
              </DialogTitle>
              <DialogDescription className="sr-only">
                Active le micro pour parler. La transcription et la réponse restent consultables à l’écran.
                Appuie sur Échap pour fermer.
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Fermer le mode vocal"
                className="flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full border border-border bg-secondary/40 text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
              >
                <X aria-hidden="true" className="h-[20px] w-[20px]" />
              </button>
            </DialogClose>
          </div>

          {/* Center: status + waveform */}
          <div
            role="region"
            aria-label="Transcription et réponse"
            tabIndex={0}
            className="flex min-h-0 min-w-0 w-full max-w-2xl flex-col items-center gap-[12px] overflow-y-auto overscroll-contain rounded-lg px-[4px] py-[8px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media_(min-width:640px)_and_(min-height:480px)]:gap-[24px] [@media_(min-width:640px)_and_(min-height:480px)]:py-[16px]"
          >
            <div className="flex w-full shrink-0 items-center justify-center gap-[8px]">
              <div
                aria-hidden="true"
                className="hidden h-[48px] w-[48px] shrink-0 items-center justify-center rounded-2xl text-2xl [@media_(min-width:640px)_and_(min-height:480px)]:flex"
                style={{ background: `${agentColor}25`, border: `1px solid ${agentColor}55` }}
              >
                {agentEmoji}
              </div>
              <p className="min-w-0 break-words text-center text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{agentName}</p>
            </div>
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
          <div className="flex w-full max-w-2xl flex-col items-center gap-[4px]">
            <button
              type="button"
              onClick={handleMicTap}
              disabled={phase === 'thinking'}
              aria-label={phase === 'listening' ? "Terminer l'enregistrement"
                : phase === 'speaking' ? 'Interrompre la réponse'
                  : phase === 'thinking' ? 'Traitement en cours'
                    : 'Activer le micro'}
              className={cn(
                'relative h-[64px] w-[64px] shrink-0 rounded-full flex items-center justify-center transition-all [@media_(min-width:640px)_and_(min-height:480px)]:h-[80px] [@media_(min-width:640px)_and_(min-height:480px)]:w-[80px]',
                'border-2 shadow-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:animate-none motion-reduce:transition-none',
                phase === 'listening' && 'bg-red-500/20 border-red-500/60 animate-pulse',
                phase === 'speaking' && 'bg-accent-purple/20 border-accent-purple/60',
                phase === 'thinking' && 'bg-secondary border-border',
                phase === 'idle' && 'bg-secondary/60 border-border hover:bg-secondary',
              )}
              style={phase === 'idle' ? { boxShadow: `0 0 40px ${agentColor}40` } : undefined}
            >
              {phase === 'thinking' ? (
                <Loader2 aria-hidden="true" className="h-[28px] w-[28px] animate-spin text-accent-purple motion-reduce:animate-none [@media_(min-width:640px)_and_(min-height:480px)]:h-[32px] [@media_(min-width:640px)_and_(min-height:480px)]:w-[32px]" />
              ) : phase === 'listening' ? (
                <MicOff aria-hidden="true" className="h-[28px] w-[28px] text-red-400 [@media_(min-width:640px)_and_(min-height:480px)]:h-[32px] [@media_(min-width:640px)_and_(min-height:480px)]:w-[32px]" />
              ) : (
                <Mic aria-hidden="true" className="h-[28px] w-[28px] [@media_(min-width:640px)_and_(min-height:480px)]:h-[32px] [@media_(min-width:640px)_and_(min-height:480px)]:w-[32px]" style={{ color: agentColor }} />
              )}
            </button>
            <p className="max-w-full text-center text-xs text-muted-foreground">
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
    <div aria-hidden="true" className="hidden h-[128px] w-full shrink-0 items-center justify-center gap-[6px] [@media_(min-width:640px)_and_(min-height:480px)]:flex">
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

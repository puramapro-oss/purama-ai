import { useState, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Wind, Play, Pause, RotateCcw, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useAwakening } from '@/hooks/useAwakening';
import { toast } from 'sonner';

type Phase = 'idle' | 'inhale' | 'hold' | 'exhale';

const PHASE_DURATIONS: Record<Exclude<Phase, 'idle'>, number> = {
  inhale: 4,
  hold: 7,
  exhale: 8,
};

const PHASE_LABELS: Record<Phase, string> = {
  idle: 'Pret ?',
  inhale: 'Inspire...',
  hold: 'Retiens...',
  exhale: 'Expire...',
};

const PHASE_COLORS: Record<Phase, string> = {
  idle: 'from-accent-purple/30 to-accent-cyan/30',
  inhale: 'from-accent-cyan/40 to-accent-emerald/40',
  hold: 'from-accent-purple/40 to-accent-pink/40',
  exhale: 'from-accent-emerald/40 to-accent-cyan/40',
};

const TOTAL_CYCLES = 4;

export default function Breathe() {
  const { recordBreathSession } = useAwakening();
  const [isRunning, setIsRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [cycle, setCycle] = useState(0);
  const [completed, setCompleted] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const nextPhase = useCallback((currentPhase: Phase, currentCycle: number) => {
    if (currentPhase === 'idle' || currentPhase === 'exhale') {
      const newCycle = currentPhase === 'exhale' ? currentCycle + 1 : currentCycle;
      if (newCycle >= TOTAL_CYCLES) {
        setIsRunning(false);
        setPhase('idle');
        setCompleted(true);
        recordBreathSession();
        toast.success('Seance terminee ! +50 XP eveil');
        return;
      }
      setCycle(newCycle);
      setPhase('inhale');
      setSecondsLeft(PHASE_DURATIONS.inhale);
    } else if (currentPhase === 'inhale') {
      setPhase('hold');
      setSecondsLeft(PHASE_DURATIONS.hold);
    } else if (currentPhase === 'hold') {
      setPhase('exhale');
      setSecondsLeft(PHASE_DURATIONS.exhale);
    }
  }, [recordBreathSession]);

  useEffect(() => {
    if (!isRunning) {
      cleanup();
      return;
    }

    timerRef.current = setInterval(() => {
      setSecondsLeft(prev => {
        if (prev <= 1) {
          setPhase(currentPhase => {
            setCycle(currentCycle => {
              nextPhase(currentPhase, currentCycle);
              return currentCycle;
            });
            return currentPhase;
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return cleanup;
  }, [isRunning, cleanup, nextPhase]);

  const start = () => {
    setCompleted(false);
    setCycle(0);
    setPhase('inhale');
    setSecondsLeft(PHASE_DURATIONS.inhale);
    setIsRunning(true);
  };

  const pause = () => {
    setIsRunning(false);
  };

  const reset = () => {
    cleanup();
    setIsRunning(false);
    setPhase('idle');
    setSecondsLeft(0);
    setCycle(0);
    setCompleted(false);
  };

  const circleScale = phase === 'inhale' ? 1.3 : phase === 'exhale' ? 0.8 : 1;
  const phaseDuration = phase !== 'idle' ? PHASE_DURATIONS[phase] : 1;
  const progress = phase !== 'idle' ? ((phaseDuration - secondsLeft) / phaseDuration) * 100 : 0;

  return (
    <div className="space-y-6 max-w-lg mx-auto">
      <div>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <Wind className="w-7 h-7 text-accent-cyan" />
          Respiration 4-7-8
        </h1>
        <p className="text-muted-foreground mt-1">Inspire 4s, retiens 7s, expire 8s</p>
      </div>

      {/* Breathing circle */}
      <div className="flex flex-col items-center py-8">
        <div className="relative w-64 h-64 flex items-center justify-center">
          {/* Background ring */}
          <svg className="absolute inset-0 w-full h-full -rotate-90">
            <circle cx="128" cy="128" r="120" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/5" />
            {phase !== 'idle' && (
              <circle
                cx="128" cy="128" r="120"
                fill="none"
                stroke="url(#breathGradient)"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 120}
                strokeDashoffset={2 * Math.PI * 120 * (1 - progress / 100)}
                className="transition-all duration-1000 ease-linear"
              />
            )}
            <defs>
              <linearGradient id="breathGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent-cyan)" />
                <stop offset="100%" stopColor="var(--accent-purple)" />
              </linearGradient>
            </defs>
          </svg>

          {/* Pulsing orb */}
          <motion.div
            animate={{ scale: circleScale }}
            transition={{ duration: phase !== 'idle' ? phaseDuration : 0.5, ease: 'easeInOut' }}
            className={`w-40 h-40 rounded-full bg-gradient-to-br ${PHASE_COLORS[phase]} backdrop-blur-xl border border-white/10 flex flex-col items-center justify-center`}
          >
            <span className="text-sm uppercase tracking-widest text-foreground/60 mb-1">
              {PHASE_LABELS[phase]}
            </span>
            {phase !== 'idle' && (
              <span className="text-4xl font-orbitron font-bold text-foreground">{secondsLeft}</span>
            )}
          </motion.div>
        </div>

        {/* Cycle indicator */}
        <div className="flex gap-2 mt-6">
          {Array.from({ length: TOTAL_CYCLES }).map((_, i) => (
            <div
              key={i}
              className={`w-3 h-3 rounded-full transition-all duration-300 ${
                i < cycle ? 'bg-accent-cyan' : i === cycle && isRunning ? 'bg-accent-purple animate-pulse' : 'bg-white/10'
              }`}
            />
          ))}
        </div>
      </div>

      {/* Controls */}
      <div className="flex justify-center gap-4">
        {!isRunning && !completed ? (
          <Button onClick={start} className="btn-primary px-8">
            <Play className="w-5 h-5 mr-2" />
            {phase === 'idle' && cycle === 0 ? 'Commencer' : 'Reprendre'}
          </Button>
        ) : isRunning ? (
          <Button onClick={pause} variant="outline" className="px-8">
            <Pause className="w-5 h-5 mr-2" />
            Pause
          </Button>
        ) : null}
        {(cycle > 0 || completed) && (
          <Button onClick={reset} variant="outline">
            <RotateCcw className="w-5 h-5 mr-2" />
            Recommencer
          </Button>
        )}
      </div>

      {/* Completion card */}
      {completed && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <Card className="bg-gradient-to-br from-accent-emerald/10 to-accent-cyan/10 border-accent-emerald/20">
            <CardContent className="pt-6 text-center">
              <CheckCircle className="w-10 h-10 text-accent-emerald mx-auto mb-3" />
              <h3 className="font-semibold text-foreground mb-1">Seance terminee</h3>
              <p className="text-sm text-muted-foreground">Tu as gagne +50 XP eveil. Continue comme ca !</p>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {/* Info */}
      <Card className="bg-card/50 border-border">
        <CardContent className="pt-6">
          <h3 className="font-semibold text-foreground mb-2">La technique 4-7-8</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Developpee par le Dr Andrew Weil, cette technique active le systeme nerveux parasympathique.
            Elle reduit le stress, l'anxiete et ameliore la qualite du sommeil.
            Pratique-la 2 fois par jour pour des resultats optimaux.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

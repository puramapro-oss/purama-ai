import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot } from 'lucide-react';
import { useLocation } from 'react-router-dom';

const INTRO_SEEN_KEY = 'purama_ai_intro_seen';

function rememberIntroSeen() {
  try {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // A decorative introduction must not require writable browser storage.
  }
}

export function CinematicIntro() {
  const location = useLocation();
  // Direct links and authentication callbacks must reach their destination.
  const eligible = location.pathname === '/' && !location.search && !location.hash;
  const [activeVisit, setActiveVisit] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);
  const attemptedVisit = useRef<string | null>(null);
  const completed = useRef(false);
  const dismiss = useRef<(() => void) | null>(null);
  const skipControl = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setActiveVisit(null);
    if (!completed.current && attemptedVisit.current !== null && attemptedVisit.current !== location.key) {
      completed.current = true;
      rememberIntroSeen();
    }
    if (!eligible || completed.current) return;

    let preference: MediaQueryList;
    try {
      if (window.localStorage.getItem(INTRO_SEEN_KEY)) {
        completed.current = true;
        return;
      }
      if (typeof window.matchMedia !== 'function') return;
      preference = window.matchMedia('(prefers-reduced-motion: reduce)');
      if (preference.matches) return;
    } catch {
      // Unknown preferences or unavailable storage favor immediate access.
      return;
    }

    let active = true;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let removePreferenceListener = () => {};
    const dispose = () => {
      active = false;
      for (const timer of timers) clearTimeout(timer);
      try { removePreferenceListener(); } catch { /* Browser listener already unavailable. */ }
      if (dismiss.current === finish) dismiss.current = null;
    };
    const finish = () => {
      if (!active) return;
      dispose();
      completed.current = true;
      rememberIntroSeen();
      setActiveVisit(null);
    };
    const preferenceChanged = (event: MediaQueryListEvent) => {
      if (event.matches) finish();
    };

    try {
      if (typeof preference.addEventListener === 'function') {
        removePreferenceListener = () => preference.removeEventListener('change', preferenceChanged);
        preference.addEventListener('change', preferenceChanged);
      } else if (typeof preference.addListener === 'function') {
        removePreferenceListener = () => preference.removeListener(preferenceChanged);
        preference.addListener(preferenceChanged);
      } else {
        return;
      }
    } catch {
      dispose();
      return;
    }

    attemptedVisit.current = location.key;
    setPhase(0);
    setActiveVisit(location.key);
    dismiss.current = finish;
    timers.push(
      setTimeout(() => { if (active) setPhase(1); }, 800),
      setTimeout(() => { if (active) setPhase(2); }, 2000),
      setTimeout(finish, 3500),
    );
    return dispose;
  }, [eligible, location.key]);

  const visible = eligible && activeVisit === location.key;
  useEffect(() => {
    if (!visible) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const control = skipControl.current;
    control?.focus();
    return () => {
      if (previous?.isConnected && (document.activeElement === control || document.activeElement === document.body)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, [visible]);

  const skip = () => {
    dismiss.current?.();
  };

  if (!visible) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        role="dialog"
        aria-modal="true"
        aria-label="Bienvenue sur PURAMA"
        className="fixed inset-0 z-[9999] bg-[#0A0A0F] flex items-center justify-center"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            skip();
          } else if (event.key === 'Tab') {
            event.preventDefault();
            skipControl.current?.focus();
          }
        }}
      >
        {/* Radial glow */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(124,58,237,0.08)_0%,transparent_70%)]" />

        {/* Grid pattern */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)',
            backgroundSize: '60px 60px',
          }}
        />

        {/* Content */}
        <div className="relative z-10 text-center">
          {/* Logo icon */}
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 200, damping: 15 }}
            className="mb-8"
          >
            <div className="w-20 h-20 mx-auto rounded-2xl bg-gradient-to-br from-accent-purple/20 to-accent-cyan/20 border border-white/10 flex items-center justify-center">
              <Bot className="w-10 h-10 text-accent-cyan" aria-hidden="true" />
            </div>
          </motion.div>

          {/* Title */}
          <AnimatePresence>
            {phase >= 1 && (
              <motion.h1
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="text-4xl md:text-6xl font-orbitron font-bold text-white"
              >
                PURAMA{' '}
                <span className="text-transparent bg-clip-text bg-gradient-to-r from-accent-purple to-accent-cyan">
                  AI
                </span>
              </motion.h1>
            )}
          </AnimatePresence>

          {/* Subtitle */}
          <AnimatePresence>
            {phase >= 2 && (
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="mt-4 text-lg text-white/50 font-space"
              >
                Tes agents IA autonomes
              </motion.p>
            )}
          </AnimatePresence>
        </div>

        <button
          ref={skipControl}
          type="button"
          onClick={skip}
          className="absolute bottom-8 z-20 rounded-lg border border-white/30 bg-white/10 px-5 py-3 text-sm font-medium text-white hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          Passer l’introduction
        </button>

        {/* Aurora glow */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.15, 0.05, 0.15] }}
          transition={{ duration: 4, repeat: Infinity }}
          className="absolute top-0 left-1/4 w-1/2 h-1/2 bg-gradient-to-b from-accent-purple/20 via-accent-cyan/10 to-transparent rounded-full blur-3xl"
        />
      </motion.div>
    </AnimatePresence>
  );
}

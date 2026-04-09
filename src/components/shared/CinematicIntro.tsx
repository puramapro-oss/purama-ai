import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot } from 'lucide-react';

export function CinematicIntro() {
  const [show, setShow] = useState(false);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const seen = localStorage.getItem('purama_ai_intro_seen');
    if (!seen) {
      setShow(true);
      // Phase transitions
      const t1 = setTimeout(() => setPhase(1), 800);
      const t2 = setTimeout(() => setPhase(2), 2000);
      const t3 = setTimeout(() => {
        setShow(false);
        localStorage.setItem('purama_ai_intro_seen', '1');
      }, 3500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }
  }, []);

  const skip = () => {
    setShow(false);
    localStorage.setItem('purama_ai_intro_seen', '1');
  };

  if (!show) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] bg-[#0A0A0F] flex items-center justify-center cursor-pointer"
        onClick={skip}
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
              <Bot className="w-10 h-10 text-accent-cyan" />
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

        {/* Skip hint */}
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.3 }}
          transition={{ delay: 1 }}
          className="absolute bottom-8 text-xs text-white/30"
        >
          Appuie pour passer
        </motion.p>

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

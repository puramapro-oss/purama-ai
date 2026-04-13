import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useAwakening } from '@/hooks/useAwakening';

const AFFIRMATIONS = [
  { text: "Je suis capable de creer la vie que je desire.", category: 'puissance' },
  { text: "Chaque jour, j'avance vers ma meilleure version.", category: 'puissance' },
  { text: "L'abondance coule naturellement vers moi.", category: 'abondance' },
  { text: "Je merite le succes et la prosperite.", category: 'abondance' },
  { text: "Mon intuition me guide vers les bonnes decisions.", category: 'sagesse' },
  { text: "Je suis entoure d'amour et de bienveillance.", category: 'amour' },
  { text: "Ma creativite est une source infinie d'opportunites.", category: 'puissance' },
  { text: "Je transforme chaque defi en opportunite de croissance.", category: 'sagesse' },
  { text: "L'univers conspire en ma faveur.", category: 'abondance' },
  { text: "Je suis exactement la ou je dois etre.", category: 'sagesse' },
  { text: "Ma valeur ne depend pas des autres, elle vient de moi.", category: 'amour' },
  { text: "Chaque respiration m'ancre dans le present.", category: 'sante' },
  { text: "Je choisis la gratitude et elle multiplie mes bienfaits.", category: 'gratitude' },
  { text: "Mon potentiel est illimite.", category: 'puissance' },
  { text: "Je suis un aimant a opportunites.", category: 'abondance' },
];

const SESSION_KEY = 'purama_affirmation_shown';

export function SpiritualLayer() {
  const { user } = useAuth();
  const { recordAffirmation } = useAwakening();
  const [show, setShow] = useState(false);
  const [affirmation, setAffirmation] = useState(AFFIRMATIONS[0]);

  useEffect(() => {
    if (!user) return;
    const shown = sessionStorage.getItem(SESSION_KEY);
    if (shown) return;

    const randomIndex = Math.floor(Math.random() * AFFIRMATIONS.length);
    setAffirmation(AFFIRMATIONS[randomIndex]);
    const timer = setTimeout(() => setShow(true), 1500);
    return () => clearTimeout(timer);
  }, [user]);

  const handleAccept = () => {
    setShow(false);
    sessionStorage.setItem(SESSION_KEY, 'true');
    recordAffirmation();
  };

  const handleClose = () => {
    setShow(false);
    sessionStorage.setItem(SESSION_KEY, 'true');
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={handleClose} />
          <motion.div
            initial={{ scale: 0.9, opacity: 0, y: 20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.9, opacity: 0, y: 20 }}
            transition={{ type: 'spring', stiffness: 300, damping: 30 }}
            className="relative max-w-md w-full bg-card/90 backdrop-blur-xl border border-white/10 rounded-3xl p-8 text-center shadow-[0_0_60px_rgba(124,58,237,0.2)]"
          >
            <button
              onClick={handleClose}
              className="absolute top-4 right-4 text-white/30 hover:text-white/60 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-gradient-to-br from-accent-purple/30 to-accent-cyan/30 flex items-center justify-center">
              <Sparkles className="w-8 h-8 text-accent-cyan" />
            </div>

            <p className="text-xs uppercase tracking-widest text-accent-purple/80 mb-4">
              Affirmation du jour
            </p>

            <p className="text-xl font-light text-foreground leading-relaxed mb-8">
              "{affirmation.text}"
            </p>

            <button
              onClick={handleAccept}
              className="w-full py-3.5 rounded-2xl font-semibold text-white bg-gradient-to-r from-accent-purple to-accent-cyan hover:opacity-90 active:scale-[0.98] transition-all duration-200 shadow-[0_4px_20px_rgba(124,58,237,0.3)]"
            >
              J'integre ✨
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

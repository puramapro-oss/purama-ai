import { motion, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Brain, Zap, Palette, Rocket } from 'lucide-react';
import { useState, useEffect, useCallback } from 'react';

const typewriterText = "Un assistant pour mon restaurant italien qui prend les commandes, recommande les plats du jour et gère les réservations...";

const miniFeatures = [
  { icon: Brain, label: 'Compréhension naturelle', desc: "Écris comme tu parles, l'IA comprend tout" },
  { icon: Zap, label: 'Création instantanée', desc: "De l'idée à l'agent en 60 secondes" },
  { icon: Palette, label: '100% personnalisable', desc: "Nom, personnalité, compétences, apparence" },
  { icon: Rocket, label: 'Déploiement 1 clic', desc: "Intégré à ton site automatiquement" },
];

const agentTags = ['Chaleureux', 'Gourmand', 'Efficace'];
const agentSkills = ['📋 Prises de commandes', '🍝 Recommandations', '📅 Réservations'];

function MockupAnimation() {
  const [phase, setPhase] = useState<'typing' | 'forging' | 'result'>('typing');
  const [typedChars, setTypedChars] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setTypedChars(prev => {
        if (prev >= typewriterText.length) return prev;
        return prev + 1;
      });
    }, 40);
    const forgeTimeout = setTimeout(() => setPhase('forging'), typewriterText.length * 40 + 500);
    const resultTimeout = setTimeout(() => setPhase('result'), typewriterText.length * 40 + 2000);
    const resetTimeout = setTimeout(() => {
      setPhase('typing');
      setTypedChars(0);
    }, typewriterText.length * 40 + 10000);

    return () => {
      clearInterval(interval);
      clearTimeout(forgeTimeout);
      clearTimeout(resultTimeout);
      clearTimeout(resetTimeout);
    };
  }, [phase === 'typing' ? 'typing' : 'other']);

  return (
    <div className="futuristic-card p-6 max-w-md mx-auto relative overflow-hidden">
      <AnimatePresence mode="wait">
        {phase === 'typing' && (
          <motion.div key="typing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="text-xs text-muted-foreground mb-2 font-medium">Décris ton agent...</p>
            <div className="bg-secondary/50 rounded-lg p-4 min-h-[80px] border border-accent-cyan/20">
              <p className="text-sm text-foreground/90 leading-relaxed">
                {typewriterText.slice(0, typedChars)}
                <span className="inline-block w-0.5 h-4 bg-accent-cyan animate-pulse ml-0.5" />
              </p>
            </div>
          </motion.div>
        )}
        {phase === 'forging' && (
          <motion.div key="forging" initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} className="flex flex-col items-center py-8">
            <motion.div animate={{ rotate: 360, scale: [1, 1.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }} className="w-16 h-16 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple flex items-center justify-center" style={{ boxShadow: '0 0 40px rgba(0,240,255,0.5)' }}>
              <Zap className="w-8 h-8 text-primary-foreground" />
            </motion.div>
            <p className="text-accent-cyan font-orbitron text-sm mt-4">Forge en cours...</p>
          </motion.div>
        )}
        {phase === 'result' && (
          <motion.div key="result" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-12 h-12 rounded-full bg-gradient-to-r from-accent-pink to-accent-purple flex items-center justify-center text-xl" style={{ boxShadow: '0 0 20px rgba(244,114,182,0.4)' }}>🍕</div>
              <div>
                <motion.h4 initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="font-orbitron font-bold text-foreground">ChefBot 🍕</motion.h4>
                <p className="text-xs text-muted-foreground">Agent Restaurant</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {agentTags.map((tag, i) => (
                <motion.span key={tag} initial={{ opacity: 0, scale: 0 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.4 + i * 0.15 }} className="px-2.5 py-1 rounded-full bg-accent-purple/20 text-accent-purple text-xs font-medium border border-accent-purple/30">{tag}</motion.span>
              ))}
            </div>
            <div className="space-y-1.5 mb-3">
              {agentSkills.map((skill, i) => (
                <motion.div key={skill} initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.8 + i * 0.15 }} className="text-xs text-foreground/80 bg-secondary/30 rounded px-2.5 py-1.5">{skill}</motion.div>
              ))}
            </div>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.3 }} className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-lg p-3">
              <p className="text-xs text-accent-cyan">💬 "Buongiorno! 🇮🇹 Qu'est-ce qui vous ferait plaisir aujourd'hui ?"</p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function OriginForgeHero() {
  return (
    <section className="relative py-24 overflow-hidden">
      {/* Neural network background */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-accent-purple/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent-cyan/10 rounded-full blur-[120px]" />
      </div>

      <div className="container mx-auto px-6 relative z-10">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-12 items-center">
          {/* Left column - 60% */}
          <div className="lg:col-span-3">
            {/* Badge */}
            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="inline-flex items-center gap-2 mb-6">
              <span className="relative px-4 py-1.5 rounded-full text-sm font-semibold overflow-hidden">
                <span className="absolute inset-0 bg-gradient-to-r from-yellow-500/20 to-amber-500/20 border border-yellow-500/30 rounded-full" />
                <motion.span className="absolute inset-0 bg-gradient-to-r from-transparent via-yellow-400/30 to-transparent rounded-full" animate={{ x: ['-100%', '200%'] }} transition={{ duration: 2, repeat: Infinity }} />
                <span className="relative text-yellow-400">⚡ RÉVOLUTIONNAIRE</span>
              </span>
            </motion.div>

            <motion.h2 initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 }} className="text-3xl sm:text-4xl lg:text-5xl font-orbitron font-black leading-tight mb-6">
              <span className="gradient-text">Forge ton Agent IA</span>{' '}
              <span className="text-foreground">avec un simple prompt</span>
            </motion.h2>

            <motion.p initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: 0.2 }} className="text-muted-foreground text-lg max-w-xl mb-8">
              Décris ton business en quelques mots. Origin Forge crée ton agent IA parfait — personnalité, compétences, widget chat — déployé en 60 secondes.
            </motion.p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
              {miniFeatures.map((feat, i) => (
                <motion.div key={feat.label} initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.3 + i * 0.1 }} className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
                    <feat.icon className="w-4 h-4 text-accent-cyan" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{feat.label}</p>
                    <p className="text-xs text-muted-foreground">{feat.desc}</p>
                  </div>
                </motion.div>
              ))}
            </div>

            <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.7 }} className="flex flex-wrap gap-3">
              <Link to="/dashboard" className="btn-primary flex items-center gap-2 text-base px-6 py-3">
                Créer mon Agent IA →
              </Link>
              <button onClick={() => document.getElementById('origin-demo')?.scrollIntoView({ behavior: 'smooth' })} className="btn-secondary text-base px-6 py-3">
                Voir la démo ↓
              </button>
            </motion.div>
          </div>

          {/* Right column - 40% */}
          <motion.div initial={{ opacity: 0, x: 30 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} transition={{ delay: 0.4 }} className="lg:col-span-2">
            <MockupAnimation />
          </motion.div>
        </div>
      </div>
    </section>
  );
}

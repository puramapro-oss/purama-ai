import { motion } from 'framer-motion';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Loader2 } from 'lucide-react';

const placeholders = [
  "Un chatbot pour mon salon de coiffure...",
  "Un assistant RH pour mes recrutements...",
  "Un agent support pour ma boutique en ligne...",
  "Un conseiller pour mon cabinet comptable...",
];

const examples = [
  { emoji: '🛍️', label: 'Agent e-commerce', prompt: "Un agent IA pour ma boutique e-commerce qui aide les clients à trouver les bons produits, gère les retours et répond aux questions sur la livraison." },
  { emoji: '🏠', label: 'Agent immobilier', prompt: "Un assistant IA pour mon agence immobilière qui qualifie les prospects, répond aux questions sur les biens disponibles et planifie les visites." },
  { emoji: '💪', label: 'Coach sportif', prompt: "Un coach IA personnalisé qui crée des programmes d'entraînement, suit la progression des clients et donne des conseils nutrition." },
];

export function OriginForgeDemo() {
  const [prompt, setPrompt] = useState('');
  const [isForging, setIsForging] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const interval = setInterval(() => setPlaceholderIdx(i => (i + 1) % placeholders.length), 3000);
    return () => clearInterval(interval);
  }, []);

  const handleForge = () => {
    if (!prompt.trim()) return;
    setIsForging(true);
    setTimeout(() => {
      setIsForging(false);
      setShowResult(true);
    }, 3000);
  };

  return (
    <section id="origin-demo" className="relative py-20 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/30 to-background" />

      <div className="container mx-auto px-6 relative z-10 max-w-3xl">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-10">
          <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-3">
            <span className="gradient-text">Essaie maintenant</span>
            <span className="text-foreground"> — c'est gratuit</span>
          </h2>
          <p className="text-muted-foreground">Écris ton prompt, vois la magie opérer.</p>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 }} className="futuristic-card p-6">
          <div className="flex flex-col sm:flex-row gap-3">
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder={placeholders[placeholderIdx]}
              rows={3}
              className="flex-1 bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 resize-none focus:outline-none focus:border-accent-cyan/50 transition-colors"
            />
            <button
              onClick={handleForge}
              disabled={isForging || !prompt.trim()}
              className="btn-primary flex items-center justify-center gap-2 px-6 py-3 h-fit self-end disabled:opacity-50 whitespace-nowrap"
            >
              {isForging ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
              {isForging ? 'Forge...' : 'Forger'}
            </button>
          </div>

          {isForging && (
            <div className="mt-4">
              <div className="h-1.5 bg-secondary/50 rounded-full overflow-hidden">
                <motion.div className="h-full bg-gradient-to-r from-accent-cyan to-accent-purple rounded-full" initial={{ width: '0%' }} animate={{ width: '100%' }} transition={{ duration: 3 }} />
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">Analyse du prompt... Génération de l'agent... Déploiement...</p>
            </div>
          )}

          {showResult && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-4 bg-accent-cyan/5 border border-accent-cyan/20 rounded-lg p-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple flex items-center justify-center text-lg">🤖</div>
                <div>
                  <p className="font-orbitron font-bold text-sm text-foreground">SmartAssist</p>
                  <p className="text-xs text-muted-foreground">3 compétences • Prêt à déployer</p>
                </div>
              </div>
              <button onClick={() => navigate('/forge')} className="text-accent-cyan text-sm font-semibold hover:underline mt-2">
                Voir le résultat complet sur Origin Forge →
              </button>
            </motion.div>
          )}

          {/* Examples */}
          <div className="flex flex-wrap gap-2 mt-4">
            {examples.map(ex => (
              <button key={ex.label} onClick={() => { setPrompt(ex.prompt); setShowResult(false); }} className="px-3 py-1.5 rounded-full bg-secondary/50 border border-accent-purple/20 text-xs text-foreground/80 hover:bg-accent-purple/10 hover:border-accent-purple/40 transition-all cursor-pointer">
                {ex.emoji} {ex.label}
              </button>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

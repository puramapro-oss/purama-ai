import { motion } from 'framer-motion';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';

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
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const navigate = useNavigate();

  useEffect(() => {
    const interval = setInterval(() => setPlaceholderIdx(i => (i + 1) % placeholders.length), 3000);
    return () => clearInterval(interval);
  }, []);

  const handleForge = () => {
    if (!prompt.trim()) return;
    navigate('/forge', { state: { prompt: prompt.trim() } });
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
          <p className="text-muted-foreground">Décris ton besoin, puis configure ton agent dans Origin Forge.</p>
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
              disabled={!prompt.trim()}
              className="btn-primary flex items-center justify-center gap-2 px-6 py-3 h-fit self-end disabled:opacity-50 whitespace-nowrap"
            >
              <Zap className="w-4 h-4" />
              Continuer
            </button>
          </div>

          {/* Examples */}
          <div className="flex flex-wrap gap-2 mt-4">
            {examples.map(ex => (
              <button key={ex.label} onClick={() => setPrompt(ex.prompt)} className="px-3 py-1.5 rounded-full bg-secondary/50 border border-accent-purple/20 text-xs text-foreground/80 hover:bg-accent-purple/10 hover:border-accent-purple/40 transition-all cursor-pointer">
                {ex.emoji} {ex.label}
              </button>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}

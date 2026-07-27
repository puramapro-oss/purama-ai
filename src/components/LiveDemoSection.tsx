import { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Mail, Loader2, ArrowRight, Sparkles } from 'lucide-react';
import { parseSSEStream } from '@/lib/sse';

/**
 * Démo publique sans inscription (brief "PRICING & OFFRE IRRÉSISTIBLE") : un vrai appel Claude via
 * l'edge function ai-demo (pas de setTimeout/résultat fabriqué comme OriginForgeDemo). Purement
 * génératif — 0 envoi réel, 0 écriture DB — donc sûr pour un visiteur anonyme.
 */
const AI_DEMO_FUNCTION_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-demo`;
const MIN_LENGTH = 5;

const EXAMPLES = [
  "Relancer un client qui n'a pas payé sa facture depuis 30 jours",
  "M'excuser auprès d'un client pour un retard de livraison",
  "Répondre à un prospect qui demande une réduction de prix",
];

// Regroupe les mises à jour d'état sur les chunks streamés (au lieu d'un setState par delta reçu).
const RENDER_FLUSH_EVERY_CHARS = 20;

export function LiveDemoSection() {
  const [situation, setSituation] = useState('');
  const [result, setResult] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFlushedLength = useRef(0);

  const runDemo = async () => {
    if (!situation.trim() || isLoading) return;
    setIsLoading(true);
    setError(null);
    setResult('');
    lastFlushedLength.current = 0;

    try {
      const response = await fetch(AI_DEMO_FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        },
        body: JSON.stringify({ situation: situation.trim() }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `Erreur ${response.status}`);
      }

      const content = await parseSSEStream(response, (full) => {
        if (full.length - lastFlushedLength.current >= RENDER_FLUSH_EVERY_CHARS) {
          lastFlushedLength.current = full.length;
          setResult(full);
        }
      });
      setResult(content);

      if (!content.trim()) {
        setError("L'IA n'a pas pu générer de réponse. Réessaie dans un instant.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <section id="live-demo" className="relative py-20 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/30 to-background" />

      <div className="container mx-auto px-6 relative z-10 max-w-2xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="text-center mb-10"
        >
          <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-3">
            <span className="gradient-text">Regarde un employé IA travailler</span>
          </h2>
          <p className="text-muted-foreground">
            Décris une situation, l'employé Email de Purama AI rédige un vrai brouillon — sans inscription.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ delay: 0.1 }}
          className="futuristic-card p-6"
        >
          <div className="flex flex-col sm:flex-row gap-3">
            <textarea
              value={situation}
              onChange={(e) => setSituation(e.target.value)}
              placeholder="Ex : Relancer un client qui n'a pas payé sa facture..."
              aria-label="Décris une situation d'email professionnel"
              rows={3}
              maxLength={300}
              disabled={isLoading}
              className="flex-1 bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 resize-none focus:outline-none focus:border-accent-cyan/50 transition-colors disabled:opacity-60"
            />
            <button
              onClick={runDemo}
              disabled={isLoading || situation.trim().length < MIN_LENGTH}
              className="btn-primary flex items-center justify-center gap-2 px-6 py-3 h-fit self-end disabled:opacity-50 whitespace-nowrap"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
              {isLoading ? 'Rédaction...' : 'Générer'}
            </button>
          </div>

          {/* Examples */}
          <div className="flex flex-wrap gap-2 mt-4">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setSituation(ex)}
                disabled={isLoading}
                className="px-3 py-1.5 rounded-full bg-secondary/50 border border-accent-purple/20 text-xs text-foreground/80 hover:bg-accent-purple/10 hover:border-accent-purple/40 transition-all cursor-pointer disabled:opacity-50"
              >
                {ex}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-4 bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {(result || isLoading) && !error && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 bg-accent-cyan/5 border border-accent-cyan/20 rounded-lg p-4"
            >
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple flex items-center justify-center text-lg flex-shrink-0">
                  ✉️
                </div>
                <div>
                  <p className="font-orbitron font-bold text-sm text-foreground">Employé Email IA</p>
                  <p className="text-xs text-muted-foreground">Génération en direct — Claude AI</p>
                </div>
              </div>
              <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">
                {result}
                {isLoading && <span className="inline-block w-1.5 h-4 bg-accent-cyan/70 ml-0.5 animate-pulse align-text-bottom" />}
              </p>
              {result && !isLoading && (
                <Link
                  to="/signup"
                  className="mt-4 inline-flex items-center gap-1.5 text-accent-cyan text-sm font-semibold hover:underline"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Débloquer les 45 employés IA — Essai 14 jours sans carte
                  <ArrowRight className="w-3.5 h-3.5" />
                </Link>
              )}
            </motion.div>
          )}
        </motion.div>
      </div>
    </section>
  );
}

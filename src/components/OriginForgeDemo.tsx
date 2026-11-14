import { motion } from 'framer-motion';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowUpRight, Wand2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { saveWorkshopDraft } from '@/lib/workshop';

const examples = [
  { emoji: '🍽️', label: 'Site de restaurant', prompt: 'Un site pour mon restaurant, avec un menu facile à mettre à jour, les horaires, une réservation et une expérience soignée sur mobile.' },
  { emoji: '🛍️', label: 'Boutique en ligne', prompt: 'Une boutique en ligne pour présenter mes produits avec leurs variantes, un panier, un parcours de commande et un suivi des commandes.' },
  { emoji: '📅', label: 'Application de réservation', prompt: 'Une application de réservation pour mon activité, avec disponibilités, espace client, confirmations et gestion des rendez-vous.' },
];

export function OriginForgeDemo() {
  const [prompt, setPrompt] = useState('');
  const navigate = useNavigate();
  const { user } = useAuth();

  const handleForge = () => {
    const goal = prompt.trim();
    if (!goal) return;
    saveWorkshopDraft(goal, user?.id ?? null);
    navigate('/dashboard/atelier', { state: user ? { workshopPrompt: goal } : null });
  };

  return (
    <section id="origin-demo" className="relative overflow-hidden py-20">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-card/30 to-background" />
      <div className="container relative z-10 mx-auto max-w-3xl px-6">
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="mb-10 text-center">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-accent-cyan">IAO · Atelier de création</p>
          <h2 className="mb-3 text-3xl font-bold sm:text-4xl"><span className="gradient-text">Donnez forme à votre idée</span></h2>
          <p className="text-muted-foreground">Un site ou une application : décrivez votre projet et retrouvez les agents dans votre atelier.</p>
        </motion.div>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: 0.1 }} className="futuristic-card p-6">
          <label htmlFor="origin-workshop-prompt" className="mb-3 block text-sm font-medium">Votre projet</label>
          <textarea id="origin-workshop-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={6000}
            placeholder="Un site pour mon restaurant, avec le menu et les réservations…" rows={4}
            className="w-full resize-y rounded-xl border border-accent-cyan/20 bg-secondary/50 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-accent-cyan/50" />
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-relaxed text-muted-foreground">Consultez les projets disponibles, lancez une mission et suivez ses vérifications.</p>
            <button onClick={handleForge} disabled={!prompt.trim()} className="btn-primary flex shrink-0 items-center justify-center gap-2 rounded-xl px-5 py-3 disabled:opacity-50">
              <Wand2 className="h-4 w-4" aria-hidden="true" /> Ouvrir l’atelier <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mt-5 flex flex-wrap gap-2" aria-label="Exemples de projets">{examples.map(example =>
            <button key={example.label} type="button" onClick={() => setPrompt(example.prompt)} className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground">
              <span aria-hidden="true">{example.emoji}</span> {example.label}
            </button>
          )}</div>
        </motion.div>
      </div>
    </section>
  );
}

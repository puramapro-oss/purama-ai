import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BookOpen, ChevronRight, ChevronLeft, Check, Bot, Brain, Globe2, Mail,
  Calculator, Handshake, Scale, Sparkles, Wallet, Star, Gift, Ticket, Share2, Trophy
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Link } from 'react-router-dom';

const STEPS = [
  {
    title: 'Bienvenue sur Purama AI',
    description: 'Purama AI est ta plateforme d\'agents IA autonomes. Chaque agent est un expert dans son domaine et travaille pour toi 24h/24.',
    icon: Bot,
    color: 'text-accent-cyan',
    tips: [
      'Tu as accès à 6 agents spécialisés',
      'Le plan gratuit te permet de tester chaque agent',
      'Tes données sont hébergées en France, conformité RGPD',
    ],
    link: '/dashboard',
    linkLabel: 'Aller au Dashboard',
  },
  {
    title: 'Choisis tes agents',
    description: 'Sélectionne les agents qui correspondent à tes besoins. Tu peux en activer plusieurs simultanément.',
    icon: Brain,
    color: 'text-accent-purple',
    tips: [
      'Agent Social — automatise tes publications réseaux sociaux',
      'Agent Email — trie, répond et organise tes emails',
      'Agent Compta — factures, déclarations, rapports financiers',
      'Agent Juridique — contrats, veille légale, recouvrement',
      'Agent Partenariat — prospection et relances automatisées',
      'Créateur d\'agents — crée tes propres agents IA',
    ],
    link: '/dashboard/agents',
    linkLabel: 'Voir mes agents',
  },
  {
    title: 'Connecte tes comptes',
    description: 'Pour que les agents fonctionnent, connecte tes comptes externes (réseaux sociaux, email, outils comptables).',
    icon: Globe2,
    color: 'text-green-400',
    tips: [
      'Réseaux sociaux : Instagram, TikTok, LinkedIn, Twitter',
      'Email : Gmail via OAuth sécurisé',
      'Comptabilité : import de transactions',
    ],
    link: '/mes-connexions',
    linkLabel: 'Mes connexions',
  },
  {
    title: 'Gagne des points',
    description: 'Chaque action te rapporte des Points Purama. Plus tu utilises la plateforme, plus tu gagnes.',
    icon: Star,
    color: 'text-yellow-400',
    tips: [
      'Inscription : +100 points',
      'Parrainage : +200 points',
      'Partage social : +300 points (3x/jour)',
      'Streak quotidien : +10 points/jour (avec multiplicateur)',
      '1 point = 0,01€ — échange contre des réductions ou du cash',
    ],
    link: '/dashboard/boutique',
    linkLabel: 'Voir la boutique',
  },
  {
    title: 'Ouvre ton coffre quotidien',
    description: 'Chaque jour, un coffre t\'attend avec des récompenses aléatoires. Ne casse pas ton streak !',
    icon: Gift,
    color: 'text-orange-400',
    tips: [
      'Points, coupons de réduction, tickets de tirage, crédits agents',
      'Streak 7j+ = minimum coupon -10%',
      'Multiplicateur : x2 à 7j, x3 à 14j, x5 à 30j, x10 à 100j',
    ],
    link: '/dashboard/daily-gift',
    linkLabel: 'Mon coffre',
  },
  {
    title: 'Parraine et gagne',
    description: 'Partage ton lien de parrainage et gagne des commissions sur chaque abonnement de tes filleuls.',
    icon: Share2,
    color: 'text-accent-pink',
    tips: [
      '50% du premier mois + 10% récurrent à vie',
      'Paliers : Bronze → Argent → Or → Platine → Diamant → Légende',
      'Commissions versées sur ton wallet, retrait dès 5€ par IBAN',
    ],
    link: '/parrainage',
    linkLabel: 'Programme parrainage',
  },
  {
    title: 'Participe aux tirages',
    description: 'Chaque mois, 10 gagnants se partagent 4% du chiffre d\'affaires. Accumule des tickets pour augmenter tes chances.',
    icon: Ticket,
    color: 'text-accent-pink',
    tips: [
      'Tickets gratuits : inscription, parrainage, partage, streak',
      'Tickets premium : +5/mois avec un abonnement actif',
      '500 points = 1 ticket supplémentaire',
    ],
    link: '/dashboard/tirage',
    linkLabel: 'Voir le tirage',
  },
  {
    title: 'Tu es prêt !',
    description: 'Tu connais maintenant toutes les fonctionnalités de Purama AI. Lance-toi et laisse les agents travailler pour toi.',
    icon: Trophy,
    color: 'text-green-400',
    tips: [
      'Explore le dashboard pour commencer',
      'Consulte l\'aide si tu as des questions',
      'Le chatbot IA est dispo en bas à droite',
    ],
    link: '/dashboard',
    linkLabel: 'Commencer',
  },
];

export default function Guide() {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const progress = ((step + 1) / STEPS.length) * 100;

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-3">
          <BookOpen className="w-7 h-7 text-accent-cyan" />
          Guide de démarrage
        </h1>
        <p className="text-muted-foreground mt-1">
          Étape {step + 1} sur {STEPS.length}
        </p>
      </motion.div>

      {/* Progress bar */}
      <Progress value={progress} className="h-2" />

      {/* Step navigation dots */}
      <div className="flex justify-center gap-2">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => setStep(i)}
            className={`w-2.5 h-2.5 rounded-full transition-all ${
              i === step ? 'bg-accent-cyan w-6' : i < step ? 'bg-accent-cyan/40' : 'bg-secondary'
            }`}
          />
        ))}
      </div>

      {/* Step content */}
      <AnimatePresence mode="wait">
        <motion.div
          key={step}
          initial={{ opacity: 0, x: 30 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -30 }}
          transition={{ duration: 0.3 }}
        >
          <Card className="bg-card/50 backdrop-blur border-border">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4 mb-6">
                <div className={`p-4 rounded-2xl bg-secondary/50`}>
                  <current.icon className={`w-10 h-10 ${current.color}`} />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-foreground">{current.title}</h2>
                  <p className="text-muted-foreground mt-1">{current.description}</p>
                </div>
              </div>

              <div className="space-y-3 mb-6">
                {current.tips.map((tip, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.1 }}
                    className="flex items-start gap-3 p-3 rounded-lg bg-secondary/20"
                  >
                    <Check className={`w-4 h-4 mt-0.5 shrink-0 ${current.color}`} />
                    <span className="text-sm text-foreground">{tip}</span>
                  </motion.div>
                ))}
              </div>

              {current.link && (
                <Link to={current.link}>
                  <Button variant="outline" size="sm" className="text-accent-cyan">
                    {current.linkLabel}
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </Link>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </AnimatePresence>

      {/* Navigation buttons */}
      <div className="flex justify-between">
        <Button
          variant="outline"
          onClick={() => setStep(Math.max(0, step - 1))}
          disabled={step === 0}
        >
          <ChevronLeft className="w-4 h-4 mr-1" />
          Précédent
        </Button>
        {step < STEPS.length - 1 ? (
          <Button
            onClick={() => setStep(step + 1)}
            className="bg-gradient-to-r from-accent-purple to-accent-cyan"
          >
            Suivant
            <ChevronRight className="w-4 h-4 ml-1" />
          </Button>
        ) : (
          <Link to="/dashboard">
            <Button className="bg-gradient-to-r from-green-500 to-emerald-500">
              Commencer
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}

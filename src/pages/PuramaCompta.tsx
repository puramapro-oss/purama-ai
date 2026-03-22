import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Bot, ArrowLeft, Calculator, FileText, TrendingUp, CreditCard,
  PiggyBank, BarChart3, Receipt, ShieldCheck, Check, ChevronDown, ChevronUp,
  Building2, Zap, Clock, Users
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AnimatedStarfield } from '@/components/AnimatedStarfield';

const modules = [
  {
    icon: Calculator,
    title: 'Saisie Comptable IA',
    description: 'Saisie automatique des écritures comptables via OCR et IA. Factures, tickets, relevés bancaires analysés en temps réel.',
    color: 'accent-cyan',
  },
  {
    icon: Receipt,
    title: 'Facturation & Devis',
    description: 'Génération automatique de factures, devis et avoirs conformes. Suivi des paiements et relances automatiques.',
    color: 'accent-purple',
  },
  {
    icon: CreditCard,
    title: 'Rapprochement Bancaire',
    description: 'Synchronisation bancaire multi-banques. Rapprochement automatique des opérations avec vos écritures.',
    color: 'accent-pink',
  },
  {
    icon: TrendingUp,
    title: 'Tableau de Bord Financier',
    description: 'KPIs en temps réel : trésorerie, CA, charges, marges. Visualisations interactives et alertes intelligentes.',
    color: 'accent-cyan',
  },
  {
    icon: PiggyBank,
    title: 'Gestion de Trésorerie',
    description: 'Prévisions de trésorerie IA sur 3, 6 et 12 mois. Optimisation des flux et alertes de seuils critiques.',
    color: 'accent-purple',
  },
  {
    icon: BarChart3,
    title: 'Déclarations Fiscales',
    description: 'Calcul automatique TVA, IS, CFE. Pré-remplissage des déclarations et télétransmission simplifiée.',
    color: 'accent-pink',
  },
  {
    icon: FileText,
    title: 'Bilan & Compte de Résultat',
    description: 'Génération automatique du bilan, compte de résultat et annexes. Export PDF prêt pour votre expert-comptable.',
    color: 'accent-cyan',
  },
  {
    icon: ShieldCheck,
    title: 'Conformité & Audit',
    description: 'Vérification FEC, conformité anti-fraude, piste d\'audit fiable. Archivage légal sécurisé et horodaté.',
    color: 'accent-purple',
  },
];

const pricingPlans = [
  {
    name: 'Starter',
    price: '29',
    period: '/mois',
    description: 'Pour les auto-entrepreneurs et TPE',
    features: [
      'Saisie comptable IA (100 écritures/mois)',
      'Facturation illimitée',
      'Rapprochement bancaire 1 compte',
      'Tableau de bord basique',
      'Support email',
    ],
    highlighted: false,
    color: 'accent-cyan',
  },
  {
    name: 'Pro',
    price: '79',
    period: '/mois',
    description: 'Pour les PME en croissance',
    features: [
      'Saisie comptable IA illimitée',
      'Facturation & devis avancés',
      'Rapprochement multi-banques',
      'Tableau de bord temps réel',
      'Gestion de trésorerie IA',
      'Déclarations fiscales auto',
      'DAF Virtuel inclus',
      'Support prioritaire',
    ],
    highlighted: true,
    color: 'accent-purple',
  },
  {
    name: 'Business',
    price: '149',
    period: '/mois',
    description: 'Pour les entreprises établies',
    features: [
      'Tout le plan Pro',
      'Bilan & compte de résultat auto',
      'Conformité & audit complet',
      'Multi-sociétés (jusqu\'à 5)',
      'API & intégrations avancées',
      'Export expert-comptable',
      'Account manager dédié',
      'SLA 99.9%',
    ],
    highlighted: false,
    color: 'accent-pink',
  },
];

const faqs = [
  {
    q: 'Purama Compta remplace-t-il mon expert-comptable ?',
    a: 'Non. Purama Compta est un outil de pré-comptabilité et de gestion financière IA qui automatise 80% du travail. Votre expert-comptable reste indispensable pour la validation finale, le conseil fiscal et les obligations légales. L\'outil facilite la collaboration avec lui grâce aux exports conformes.',
  },
  {
    q: 'Mes données financières sont-elles sécurisées ?',
    a: 'Absolument. Toutes les données sont chiffrées (AES-256) au repos et en transit (TLS 1.3). Hébergement en Europe (conformité RGPD), sauvegardes quotidiennes, et piste d\'audit complète. Nous sommes conformes aux exigences de l\'article 286-I du CGI.',
  },
  {
    q: 'Quelles banques sont compatibles ?',
    a: 'Purama Compta se connecte à plus de 300 banques françaises et européennes via des API sécurisées (DSP2). BNP, Société Générale, Crédit Agricole, LCL, Boursorama, Qonto, Shine, et bien d\'autres.',
  },
  {
    q: 'Le FEC généré est-il conforme ?',
    a: 'Oui. Le Fichier des Écritures Comptables (FEC) généré respecte les normes de l\'article A.47 A-1 du Livre des Procédures Fiscales. Il est vérifié automatiquement avant export pour garantir sa conformité en cas de contrôle fiscal.',
  },
  {
    q: 'Puis-je migrer depuis un autre logiciel comptable ?',
    a: 'Oui. Nous proposons un import FEC depuis n\'importe quel logiciel comptable (Sage, Cegid, QuickBooks, Pennylane, etc.). Notre équipe vous accompagne gratuitement dans la migration.',
  },
];

export default function PuramaCompta() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AnimatedStarfield />

      {/* Header */}
      <header className="relative z-20 py-6">
        <div className="container mx-auto px-6 sm:px-8 lg:px-12 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-accent-cyan transition-colors">
            <ArrowLeft className="w-5 h-5" />
            <span className="text-sm font-space">Retour</span>
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Bot className="w-8 h-8 text-accent-cyan" />
            <span className="font-orbitron text-xl font-bold">PURAMA<span className="text-accent-cyan"> AI</span></span>
          </Link>
          <Link to="/login">
            <Button variant="outline" className="border-accent-cyan/30 text-accent-cyan hover:bg-accent-cyan/10">
              Connexion
            </Button>
          </Link>
        </div>
      </header>

      <main className="relative z-10">
        {/* Hero */}
        <section className="py-20 sm:py-28">
          <div className="container mx-auto px-6 sm:px-8 lg:px-12 text-center">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-8">
                <Calculator className="w-4 h-4 text-accent-cyan" />
                <span className="text-sm font-space text-accent-cyan">Comptabilité IA Nouvelle Génération</span>
              </div>
              <h1 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
                <span className="gradient-text">Purama Compta</span>
              </h1>
              <p className="text-lg sm:text-xl text-muted-foreground max-w-3xl mx-auto mb-10 font-space leading-relaxed">
                Votre DAF virtuel propulsé par l'IA. Automatisez votre comptabilité, pilotez vos finances en temps réel et prenez des décisions éclairées — sans effort.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link to="/signup">
                  <Button className="btn-primary text-lg px-10 py-4 w-full sm:w-auto">
                    Essai gratuit 14 jours
                  </Button>
                </Link>
                <a href="#modules">
                  <Button variant="outline" className="btn-secondary text-lg px-10 py-4 w-full sm:w-auto">
                    Découvrir les modules
                  </Button>
                </a>
              </div>
            </motion.div>

            {/* Stats */}
            <motion.div
              className="grid grid-cols-2 lg:grid-cols-4 gap-6 mt-16 max-w-4xl mx-auto"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, delay: 0.3 }}
            >
              {[
                { icon: Clock, value: '80%', label: 'Temps gagné' },
                { icon: Zap, value: '< 3s', label: 'Saisie par facture' },
                { icon: Building2, value: '300+', label: 'Banques connectées' },
                { icon: Users, value: '2 500+', label: 'Entreprises' },
              ].map((stat, i) => (
                <div key={i} className="futuristic-card p-6 text-center">
                  <stat.icon className="w-6 h-6 text-accent-cyan mx-auto mb-2" />
                  <div className="text-2xl sm:text-3xl font-orbitron font-bold gradient-text">{stat.value}</div>
                  <div className="text-sm text-muted-foreground font-space">{stat.label}</div>
                </div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* 8 Modules */}
        <section id="modules" className="py-20">
          <div className="container mx-auto px-6 sm:px-8 lg:px-12">
            <motion.div
              className="text-center mb-16"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-4">
                <span className="gradient-text">8 Modules</span> Comptabilité IA
              </h2>
              <p className="text-muted-foreground font-space max-w-2xl mx-auto">
                Une suite complète qui couvre l'intégralité de vos besoins financiers, de la saisie à l'audit.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {modules.map((mod, i) => (
                <motion.div
                  key={i}
                  className="futuristic-card p-6 group"
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.1 }}
                  whileHover={{ y: -8, scale: 1.02 }}
                >
                  <div className={`w-12 h-12 rounded-xl bg-${mod.color}/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                    <mod.icon className={`w-6 h-6 text-${mod.color}`} />
                  </div>
                  <h3 className="font-orbitron font-semibold text-foreground mb-2">{mod.title}</h3>
                  <p className="text-sm text-muted-foreground font-space leading-relaxed">{mod.description}</p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="tarifs" className="py-20">
          <div className="container mx-auto px-6 sm:px-8 lg:px-12">
            <motion.div
              className="text-center mb-16"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-4">
                Tarifs <span className="gradient-text">Purama Compta</span>
              </h2>
              <p className="text-muted-foreground font-space">Sans engagement, résiliable à tout moment.</p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl mx-auto">
              {pricingPlans.map((plan, i) => (
                <motion.div
                  key={i}
                  className={`futuristic-card p-8 relative ${plan.highlighted ? 'border-accent-purple/50 shadow-[0_0_40px_rgba(124,58,237,0.2)]' : ''}`}
                  initial={{ opacity: 0, y: 30 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.15 }}
                  whileHover={{ y: -8 }}
                >
                  {plan.highlighted && (
                    <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-gradient-to-r from-accent-purple to-accent-cyan px-4 py-1 rounded-full text-xs font-orbitron font-semibold">
                      Le plus populaire
                    </div>
                  )}
                  <h3 className="font-orbitron font-bold text-xl mb-1">{plan.name}</h3>
                  <p className="text-sm text-muted-foreground font-space mb-4">{plan.description}</p>
                  <div className="flex items-baseline gap-1 mb-6">
                    <span className={`text-4xl font-orbitron font-bold text-${plan.color}`}>{plan.price}€</span>
                    <span className="text-muted-foreground text-sm font-space">{plan.period}</span>
                  </div>
                  <ul className="space-y-3 mb-8">
                    {plan.features.map((f, j) => (
                      <li key={j} className="flex items-start gap-2 text-sm font-space">
                        <Check className={`w-4 h-4 text-${plan.color} mt-0.5 flex-shrink-0`} />
                        <span className="text-muted-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link to="/signup">
                    <Button className={`w-full ${plan.highlighted ? 'btn-primary' : 'btn-secondary'}`}>
                      Commencer
                    </Button>
                  </Link>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="py-20">
          <div className="container mx-auto px-6 sm:px-8 lg:px-12 max-w-3xl">
            <motion.div
              className="text-center mb-12"
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-4">
                Questions <span className="gradient-text">Fréquentes</span>
              </h2>
            </motion.div>

            <div className="space-y-4">
              {faqs.map((faq, i) => (
                <motion.div
                  key={i}
                  className="futuristic-card overflow-hidden"
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.1 }}
                >
                  <button
                    className="w-full p-6 flex items-center justify-between text-left"
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  >
                    <span className="font-space font-medium text-foreground pr-4">{faq.q}</span>
                    {openFaq === i ? (
                      <ChevronUp className="w-5 h-5 text-accent-cyan flex-shrink-0" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    )}
                  </button>
                  {openFaq === i && (
                    <div className="px-6 pb-6">
                      <p className="text-sm text-muted-foreground font-space leading-relaxed">{faq.a}</p>
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20">
          <div className="container mx-auto px-6 sm:px-8 lg:px-12">
            <motion.div
              className="futuristic-card p-12 text-center max-w-4xl mx-auto"
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.8 }}
            >
              <h2 className="text-3xl sm:text-4xl font-orbitron font-bold mb-4">
                Prêt à automatiser votre <span className="gradient-text">comptabilité</span> ?
              </h2>
              <p className="text-muted-foreground font-space mb-8 max-w-xl mx-auto">
                Rejoignez 2 500+ entreprises qui gagnent 80% de temps sur leur gestion financière grâce à l'IA.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link to="/signup">
                  <Button className="btn-primary text-lg px-10 py-4">Essai gratuit 14 jours</Button>
                </Link>
                <Link to="/pricing">
                  <Button variant="outline" className="btn-secondary text-lg px-10 py-4">Voir tous les tarifs</Button>
                </Link>
              </div>
            </motion.div>
          </div>
        </section>
      </main>
    </div>
  );
}

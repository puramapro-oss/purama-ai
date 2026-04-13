import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Crown, Zap, Rocket, Gift, ChevronDown, Calculator } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { PLAN_LIST } from '@/lib/plans';

const ICONS = { free: Gift, starter: Zap, pro: Rocket, ultime: Crown } as const;
const COLORS = {
  free: 'from-slate-500 to-slate-600',
  starter: 'from-blue-500 to-cyan-500',
  pro: 'from-purple-500 to-pink-500',
  ultime: 'from-amber-500 to-orange-500',
} as const;

const comparisonRows = [
  { label: 'Agents IA inclus', values: ['1', '5', 'TOUS', 'TOUS'] },
  { label: 'Agents personnalisés', values: ['1', '5', '20', '100'] },
  { label: 'Exécutions/mois', values: ['500', '5 000', '50 000', '1 000 000'] },
  { label: 'Module compta', values: ['✅', '✅', '✅', '✅'] },
  { label: 'Notifications push', values: ['✅', '✅', '✅', '✅'] },
  { label: 'Marketplace agents', values: ['—', '—', '✅', '✅'] },
  { label: 'Support prioritaire', values: ['—', '—', '✅', '✅ VIP'] },
  { label: 'API + webhooks', values: ['—', '—', '✅', '✅'] },
  { label: 'White-label', values: ['—', '—', '—', '✅'] },
];

const faqItems = [
  { q: 'Qu\'est-ce qui est inclus dans Free ?', a: '1 agent IA Purama au choix (Email, Compta, Partenariat, Juridique ou Créateur) + 1 agent custom + 500 exécutions/mois. Le module compta est inclus dans tous les plans, même Free.' },
  { q: 'C\'est quoi une « exécution » ?', a: 'Chaque action de l\'IA compte pour 1 exécution : un email traité, une transaction catégorisée, un message au chat juridique, un email de prospection envoyé, etc.' },
  { q: 'Puis-je changer de plan à tout moment ?', a: 'Oui, depuis ton dashboard. L\'upgrade est immédiat, le downgrade prend effet à la fin de ta période en cours.' },
  { q: 'Y a-t-il un essai gratuit ?', a: 'Oui ! 14 jours d\'essai gratuit sur tous les plans payants. Tu peux annuler en 1 clic, sans aucun frais.' },
  { q: 'Le module compta est-il vraiment inclus partout ?', a: 'Oui. Free, Starter, Pro et Ultime ont tous accès au module compta complet : Bridge bancaire, catégorisation IA, déclarations TVA/IS, factures Factur-X.' },
];

export function PricingSection() {
  const [showComparison, setShowComparison] = useState(false);

  return (
    <section id="tarifs" className="relative py-24 overflow-hidden">
      <div className="absolute inset-0 bg-background">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-accent-purple/8 rounded-full blur-[150px]" />
      </div>

      <div className="container mx-auto px-6 relative z-10">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="text-center mb-16">
          <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-6">
            <Crown className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-medium text-foreground/80">Tarification simple, compta toujours incluse</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-orbitron font-bold mb-4">
            <span className="text-foreground">Choisissez votre </span>
            <span className="gradient-text">plan</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            5 agents IA, le module compta intégré, et la possibilité de créer vos propres agents.
            14 jours gratuits sur tous les plans payants.
          </p>
        </motion.div>

        {/* Financer banner */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-2xl mx-auto mb-8"
        >
          <Link
            to="/financer"
            className="block bg-gradient-to-r from-emerald-500/15 to-emerald-600/10 border border-emerald-500/30 rounded-xl px-6 py-4 text-center hover:border-emerald-400/50 transition-colors group"
          >
            <p className="text-emerald-400 font-semibold text-sm">
              💰 La plupart de nos clients ne paient rien grace aux aides
            </p>
            <p className="text-emerald-400/70 text-xs mt-1 group-hover:text-emerald-400/90 transition-colors">
              Verifie ton eligibilite en 2 min →
            </p>
          </Link>
        </motion.div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {PLAN_LIST.map((plan, index) => {
            const Icon = ICONS[plan.id];
            const color = COLORS[plan.id];
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className={`relative futuristic-card p-6 flex flex-col ${plan.highlight ? 'lg:scale-105 z-10' : ''}`}
                style={plan.highlight ? { boxShadow: '0 0 40px rgba(124,58,237,0.3)', borderColor: 'rgba(124,58,237,0.5)' } : {}}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-3 py-1 rounded-full text-xs font-bold bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground">
                      ⭐ POPULAIRE
                    </span>
                  </div>
                )}

                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${color} flex items-center justify-center mb-3 shadow-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>

                <h3 className="font-orbitron font-bold text-xl text-foreground">{plan.name}</h3>
                <p className="text-muted-foreground text-sm mb-4">{plan.tagline}</p>

                <div className="mb-6">
                  {plan.id === 'free' ? (
                    <>
                      <span className="text-4xl font-orbitron font-bold text-foreground">0€</span>
                      <p className="text-muted-foreground text-xs mt-1">à vie</p>
                    </>
                  ) : (
                    <>
                      <span className="text-4xl font-orbitron font-bold text-foreground">
                        {Number.isInteger(plan.monthly_price) ? plan.monthly_price : plan.monthly_price.toFixed(2)}€
                      </span>
                      <span className="text-muted-foreground text-sm">/mois</span>
                      <p className="text-accent-emerald text-xs mt-1">
                        ou {plan.yearly_price_per_month.toFixed(2)}€/mois en annuel <span className="text-muted-foreground">(−33%)</span>
                      </p>
                    </>
                  )}
                </div>

                <ul className="space-y-2.5 mb-6 flex-1">
                  {plan.features.map((f, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${plan.highlight ? 'text-accent-purple' : 'text-accent-emerald'}`} />
                      <span className="text-sm text-foreground/80">{f}</span>
                    </li>
                  ))}
                </ul>

                <Link
                  to="/pricing"
                  className={`block w-full py-3 rounded-lg font-semibold text-center transition-all text-sm ${
                    plan.highlight ? 'btn-primary' : 'btn-secondary'
                  }`}
                >
                  {plan.id === 'free' ? 'Commencer' : 'Essai 14 jours'}
                </Link>
              </motion.div>
            );
          })}
        </div>

        {/* Compta inclus banner */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="max-w-4xl mx-auto mt-10 rounded-2xl bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/30 p-5 flex items-center gap-4"
        >
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <Calculator className="w-6 h-6 text-emerald-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground">Le module Compta est inclus dans <strong>tous les plans</strong>, même Free</p>
            <p className="text-xs text-muted-foreground mt-1">
              Bridge bancaire, catégorisation IA, déclarations TVA/IS, factures Factur-X. Aucun comptable nécessaire.
            </p>
          </div>
        </motion.div>

        {/* Comparison toggle */}
        <motion.div initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} className="text-center mt-10">
          <button onClick={() => setShowComparison(!showComparison)} className="inline-flex items-center gap-2 text-accent-cyan text-sm font-semibold hover:underline">
            <ChevronDown className={`w-4 h-4 transition-transform ${showComparison ? 'rotate-180' : ''}`} />
            {showComparison ? 'Masquer' : 'Voir'} la comparaison détaillée
          </button>
        </motion.div>

        <AnimatePresence>
          {showComparison && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-6">
              <div className="overflow-x-auto">
                <table className="w-full max-w-5xl mx-auto text-sm">
                  <thead>
                    <tr className="border-b border-accent-cyan/20">
                      <th className="text-left py-3 px-4 text-muted-foreground font-medium">Fonctionnalité</th>
                      {['Free', 'Starter', 'Pro', 'Ultime'].map(h => <th key={h} className="text-center py-3 px-4 text-foreground font-orbitron font-semibold">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {comparisonRows.map((row, i) => (
                      <tr key={i} className="border-b border-border/30">
                        <td className="py-3 px-4 text-foreground/80">{row.label}</td>
                        {row.values.map((v, j) => <td key={j} className="text-center py-3 px-4 text-foreground/70">{v}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* FAQ */}
        <div className="max-w-2xl mx-auto mt-16">
          <h3 className="font-orbitron font-bold text-2xl text-foreground text-center mb-8">Questions fréquentes</h3>
          <Accordion type="single" collapsible className="space-y-2">
            {faqItems.map((faq, i) => (
              <AccordionItem key={i} value={`faq-${i}`} className="futuristic-card px-5 border-none">
                <AccordionTrigger className="text-foreground text-sm font-semibold hover:no-underline py-4">{faq.q}</AccordionTrigger>
                <AccordionContent className="text-muted-foreground text-sm pb-4">{faq.a}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>

        <motion.p initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} className="text-center mt-10 text-muted-foreground text-sm">
          ✨ Sans engagement · 14 jours gratuits · Résiliable en 1 clic · Compta toujours incluse
        </motion.p>
      </div>
    </section>
  );
}

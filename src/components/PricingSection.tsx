import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, Crown, Zap, Rocket, MessageSquare, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useState } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';

const plans = [
  {
    name: 'Découverte',
    price: '0',
    period: '/mois',
    subtitle: 'Pour tester Origin Forge',
    badge: null,
    highlight: false,
    color: 'cyan',
    features: [
      { text: '1 site ou application', included: true },
      { text: '3 crédits de création/mois', included: true },
      { text: '1 Agent IA custom', included: true, bold: true, tag: 'Origin Forge' },
      { text: '50 conversations IA/mois', included: true },
      { text: '3 compétences par agent max', included: true },
      { text: 'Templates gratuits (5)', included: true },
      { text: 'Widget chat basique', included: true },
      { text: 'Personnalisation avancée', included: false },
      { text: 'Multilingue', included: false },
      { text: 'Analytics de l\'agent', included: false },
      { text: 'Galerie communautaire', included: false },
      { text: '6 Agents automatiques', included: false },
      { text: 'Support prioritaire', included: false },
    ],
    cta: 'Commencer gratuitement',
    ctaStyle: 'btn-secondary',
    link: '/signup',
  },
  {
    name: 'Professionnel',
    price: '19',
    oldPrice: '39',
    period: '/mois',
    subtitle: 'Pour les entrepreneurs ambitieux',
    badge: '⭐ POPULAIRE',
    highlight: true,
    color: 'purple',
    features: [
      { text: 'Sites et applications illimités', included: true },
      { text: '30 crédits de création/mois', included: true },
      { text: '5 Agents IA custom', included: true, bold: true, glow: true },
      { text: '2 000 conversations IA/mois', included: true },
      { text: 'Compétences illimitées par agent', included: true },
      { text: 'Tous les templates (12+)', included: true },
      { text: 'Widget chat personnalisable', included: true },
      { text: 'Personnalité avancée (sliders)', included: true },
      { text: 'Multilingue (5 langues)', included: true },
      { text: 'Analytics de l\'agent', included: true },
      { text: '3 Agents automatiques', included: true },
      { text: 'Galerie communautaire', included: true },
      { text: 'Images IA', included: true },
      { text: 'Support prioritaire', included: true },
      { text: 'Mode Full Auto', included: false },
      { text: 'API d\'accès', included: false },
      { text: 'White-label', included: false },
    ],
    cta: 'Choisir Pro →',
    ctaStyle: 'btn-primary',
    link: '/pricing',
  },
  {
    name: 'Business',
    price: '49',
    period: '/mois',
    subtitle: 'Pour scaler sans limites',
    badge: '🚀 PUISSANCE MAX',
    highlight: false,
    color: 'blue',
    features: [
      { text: 'Tout du plan Pro +', included: true, bold: true },
      { text: 'Agents IA custom ILLIMITÉS', included: true, bold: true, glow: true },
      { text: 'Conversations IA illimitées', included: true },
      { text: '6 Agents automatiques', included: true },
      { text: 'Mode Full Auto sur tous', included: true },
      { text: 'Toutes les langues du monde', included: true },
      { text: 'Analytics avancés + rapports PDF', included: true },
      { text: 'API d\'accès (REST API)', included: true },
      { text: 'White-label', included: true },
      { text: 'Fallback humain intelligent', included: true },
      { text: 'Galerie communautaire (publier)', included: true },
      { text: 'Domaine personnalisé', included: true },
      { text: 'Sauvegardes automatiques', included: true },
      { text: 'Support dédié 24/7', included: true },
    ],
    cta: 'Choisir Business →',
    ctaStyle: 'btn-primary',
    link: '/pricing',
  },
  {
    name: 'Enterprise',
    price: 'Sur devis',
    period: '',
    subtitle: 'Pour les grandes équipes',
    badge: '👑 ENTERPRISE',
    highlight: false,
    color: 'gold',
    features: [
      { text: 'Tout du plan Business +', included: true, bold: true },
      { text: 'Agents IA fine-tunés sur vos données', included: true },
      { text: 'Agents IA personnalisés sur mesure', included: true },
      { text: 'Intégrations custom (CRM, ERP)', included: true },
      { text: 'Account manager dédié', included: true },
      { text: 'SLA garanti 99.9%', included: true },
      { text: 'Formation équipe incluse', included: true },
      { text: 'Facturation annuelle', included: true },
    ],
    cta: 'Nous contacter →',
    ctaStyle: 'btn-secondary',
    link: '/#contact-section',
  },
];

const comparisonRows = [
  { label: 'Agents IA custom', values: ['1', '5', '∞', '∞+ custom'] },
  { label: 'Conversations/mois', values: ['50', '2 000', '∞', '∞'] },
  { label: 'Compétences/agent', values: ['3', '∞', '∞', '∞'] },
  { label: 'Agents automatiques', values: ['0', '3', '6', '6+ custom'] },
  { label: 'Langues', values: ['1', '5', 'Toutes', 'Toutes'] },
  { label: 'Analytics', values: ['❌', '✅', '✅ Avancé', '✅ Custom'] },
  { label: 'API', values: ['❌', '❌', '✅', '✅'] },
  { label: 'White-label', values: ['❌', '❌', '✅', '✅'] },
];

const faqItems = [
  { q: 'Puis-je tester Origin Forge gratuitement ?', a: 'Oui ! Le plan gratuit inclut 1 agent IA custom avec 50 conversations/mois.' },
  { q: "Combien d'agents IA puis-je créer ?", a: '1 en Gratuit, 5 en Pro, illimité en Business.' },
  { q: 'Mon agent IA peut-il parler plusieurs langues ?', a: 'Oui ! 5 langues en Pro, toutes les langues en Business.' },
  { q: 'Puis-je modifier mon agent après sa création ?', a: 'Absolument, à tout moment depuis ton Dashboard.' },
  { q: 'Les conversations sont-elles sauvegardées ?', a: 'Oui, avec analytics complets en Pro et Business.' },
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
            <span className="text-sm font-medium text-foreground/80">Tarification Transparente</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-orbitron font-bold mb-4">
            <span className="text-foreground">Choisissez Votre </span>
            <span className="gradient-text">Plan</span>
          </h2>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">Des forfaits flexibles adaptés à tous les besoins. Origin Forge inclus dans chaque plan.</p>
        </motion.div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6 max-w-7xl mx-auto">
          {plans.map((plan, index) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: index * 0.1 }}
              className={`relative futuristic-card p-6 flex flex-col ${plan.highlight ? 'lg:scale-105 z-10' : ''}`}
              style={plan.highlight ? { boxShadow: '0 0 40px rgba(124,58,237,0.3)', borderColor: 'rgba(124,58,237,0.5)' } : plan.color === 'gold' ? { borderColor: 'rgba(234,179,8,0.3)' } : {}}
            >
              {plan.badge && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                  <span className={`px-3 py-1 rounded-full text-xs font-bold ${plan.highlight ? 'bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground' : plan.color === 'gold' ? 'bg-gradient-to-r from-yellow-600 to-amber-500 text-primary-foreground' : 'bg-accent-blue text-primary-foreground'}`}>
                    {plan.badge}
                  </span>
                </div>
              )}

              <h3 className="font-orbitron font-bold text-xl text-foreground mt-2">{plan.name}</h3>
              <p className="text-muted-foreground text-sm mb-4">{plan.subtitle}</p>

              <div className="mb-6">
                {plan.oldPrice && <span className="text-muted-foreground line-through text-sm mr-2">{plan.oldPrice}€</span>}
                <span className="text-4xl font-orbitron font-bold text-foreground">{plan.price}{plan.period ? '€' : ''}</span>
                <span className="text-muted-foreground text-sm">{plan.period}</span>
                {plan.oldPrice && <p className="text-accent-emerald text-xs mt-1">-50% lancement</p>}
              </div>

              <ul className="space-y-2.5 mb-6 flex-1">
                {plan.features.map((f, i) => (
                  <li key={i} className="flex items-start gap-2">
                    {f.included ? <Check className={`w-4 h-4 mt-0.5 flex-shrink-0 ${f.glow ? 'text-accent-purple' : 'text-accent-emerald'}`} /> : <X className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground/40" />}
                    <span className={`text-sm ${f.included ? 'text-foreground/80' : 'text-muted-foreground/50'} ${f.bold ? 'font-semibold' : ''} ${f.glow ? 'text-accent-purple' : ''}`}>
                      {f.text}
                      {f.tag && <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] bg-accent-cyan/10 text-accent-cyan border border-accent-cyan/20">{f.tag}</span>}
                    </span>
                  </li>
                ))}
              </ul>

              <Link to={plan.link} className={`block w-full py-3 rounded-lg font-semibold text-center transition-all text-sm ${plan.ctaStyle}`}>
                {plan.cta}
              </Link>
            </motion.div>
          ))}
        </div>

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
                      {['Gratuit', 'Pro', 'Business', 'Enterprise'].map(h => <th key={h} className="text-center py-3 px-4 text-foreground font-orbitron font-semibold">{h}</th>)}
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
          ✨ Sans engagement • Résiliable à tout moment
        </motion.p>
      </div>
    </section>
  );
}

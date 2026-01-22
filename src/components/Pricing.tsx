'use client'

import { motion } from 'framer-motion'
import { Check, Sparkles, Zap, Crown } from 'lucide-react'

const plans = [
  {
    name: 'Starter',
    price: '49',
    period: '/mois',
    description: 'Parfait pour les freelances et petites équipes',
    icon: Zap,
    color: 'cyan',
    features: [
      '3 Agents IA au choix',
      '1 000 requêtes/mois',
      'Intégrations basiques',
      'Support par email',
      'Analytics standard',
    ],
    popular: false,
  },
  {
    name: 'Business',
    price: '149',
    period: '/mois',
    description: 'Idéal pour les PME en croissance',
    icon: Sparkles,
    color: 'purple',
    features: [
      '10 Agents IA au choix',
      '10 000 requêtes/mois',
      'Toutes les intégrations',
      'Support prioritaire 24/7',
      'Analytics avancés',
      'API personnalisée',
      'Formation incluse',
    ],
    popular: true,
  },
  {
    name: 'Enterprise',
    price: '499',
    period: '/mois',
    description: 'Solution complète pour les grandes entreprises',
    icon: Crown,
    color: 'pink',
    features: [
      '20 Agents IA (tous inclus)',
      'Requêtes illimitées',
      'Intégrations sur mesure',
      'Account Manager dédié',
      'SLA garanti 99.9%',
      'Agents personnalisés',
      'Déploiement on-premise',
      'Audit sécurité inclus',
    ],
    popular: false,
  },
]

export function Pricing() {
  return (
    <section id="tarifs" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-background">
        <div className="absolute inset-0 grid-pattern opacity-30" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-accent-purple/10 rounded-full blur-[150px]" />
      </div>

      <div className="container mx-auto px-6 sm:px-8 lg:px-12 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
          className="text-center mb-16"
        >
          <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-6">
            <Crown className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-medium text-foreground/80">Tarification Transparente</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Choisissez Votre </span>
            <span className="gradient-text">Plan</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Des forfaits flexibles adaptés à tous les besoins. Changez de plan à tout moment.
          </p>
        </motion.div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {plans.map((plan, index) => {
            const Icon = plan.icon
            const colorMap = {
              cyan: {
                border: 'border-accent-cyan/30 hover:border-accent-cyan/60',
                icon: 'text-accent-cyan bg-accent-cyan/10',
                button: 'bg-accent-cyan hover:bg-accent-cyan/80',
                check: 'text-accent-cyan',
              },
              purple: {
                border: 'border-accent-purple/50 hover:border-accent-purple',
                icon: 'text-accent-purple bg-accent-purple/10',
                button: 'bg-gradient-to-r from-accent-cyan to-accent-purple hover:opacity-90',
                check: 'text-accent-purple',
              },
              pink: {
                border: 'border-accent-pink/30 hover:border-accent-pink/60',
                icon: 'text-accent-pink bg-accent-pink/10',
                button: 'bg-accent-pink hover:bg-accent-pink/80',
                check: 'text-accent-pink',
              },
            }
            const colors = colorMap[plan.color as keyof typeof colorMap]
            
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className={`
                  relative futuristic-card p-8 
                  ${colors.border}
                  ${plan.popular ? 'scale-105 lg:scale-110' : ''}
                `}
              >
                {/* Popular Badge */}
                {plan.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2">
                    <div className="bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground px-4 py-1 rounded-full text-sm font-semibold">
                      Le Plus Populaire
                    </div>
                  </div>
                )}

                {/* Icon */}
                <div className={`w-14 h-14 ${colors.icon} rounded-xl flex items-center justify-center mb-6`}>
                  <Icon className="w-7 h-7" />
                </div>

                {/* Plan Info */}
                <h3 className="text-2xl font-orbitron font-bold text-foreground mb-2">
                  {plan.name}
                </h3>
                <p className="text-muted-foreground mb-6">
                  {plan.description}
                </p>

                {/* Price */}
                <div className="mb-8">
                  <span className="text-5xl font-orbitron font-bold text-foreground">{plan.price}€</span>
                  <span className="text-muted-foreground">{plan.period}</span>
                </div>

                {/* Features */}
                <ul className="space-y-4 mb-8">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-center gap-3">
                      <Check className={`w-5 h-5 ${colors.check} flex-shrink-0`} />
                      <span className="text-foreground/80">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA */}
                <button 
                  onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
                  className={`w-full py-4 rounded-lg font-semibold text-white transition-all duration-300 ${colors.button}`}
                >
                  Commencer
                </button>
              </motion.div>
            )
          })}
        </div>

        {/* Money Back Guarantee */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="text-center mt-12"
        >
          <p className="text-muted-foreground">
            ✨ Essai gratuit de 14 jours • Sans engagement • Satisfait ou remboursé
          </p>
        </motion.div>
      </div>
    </section>
  )
}

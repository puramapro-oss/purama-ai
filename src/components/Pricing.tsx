'use client'

import { motion } from 'framer-motion'
import { Check, Zap, Crown } from 'lucide-react'
import { Link } from 'react-router-dom'

const plans = [
  {
    name: 'Starter',
    price: '66',
    period: '/mois',
    description: 'Choisissez 5 agents pour automatiser vos tâches essentielles',
    icon: Zap,
    color: 'cyan',
    features: [
      '5 agents au choix parmi 45',
      'Exécutions illimitées',
      'Support par email',
      'Toutes les intégrations',
      'Tableau de bord complet',
    ],
    popular: false,
  },
  {
    name: 'Premium',
    price: '99',
    period: '/mois',
    description: 'Accès illimité à tous les agents IA',
    icon: Crown,
    color: 'purple',
    features: [
      'Tous les 45 agents IA',
      'Exécutions illimitées',
      'Support prioritaire 24/7',
      'Toutes les intégrations',
      'Analytics avancés',
      'Agents personnalisables',
      'API access',
    ],
    popular: true,
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
            Des forfaits flexibles adaptés à tous les besoins. 14 jours d'essai gratuit inclus.
          </p>
        </motion.div>

        {/* Pricing Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
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
                  ${plan.popular ? 'lg:scale-105' : ''}
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
                  <p className="text-sm text-muted-foreground mt-1">Prix TTC • Sans engagement</p>
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
                <Link 
                  to="/pricing"
                  className={`block w-full py-4 rounded-lg font-semibold text-white text-center transition-all duration-300 ${colors.button}`}
                >
                  Commencer l'essai gratuit
                </Link>
              </motion.div>
            )
          })}
        </div>

        {/* Bottom note */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="text-center mt-12"
        >
          <p className="text-muted-foreground">
            ✨ 14 jours d'essai gratuit • Sans engagement • Résiliable à tout moment
          </p>
        </motion.div>
      </div>
    </section>
  )
}

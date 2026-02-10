'use client'

import { motion } from 'framer-motion'
import { 
  Cpu, Rocket, Lock, RefreshCw, 
  Plug, LineChart, Clock, Globe 
} from 'lucide-react'

const features = [
  {
    icon: Cpu,
    title: 'IA de Dernière Génération',
    description: 'Nos agents utilisent les modèles GPT-4 et Claude 3 pour des performances inégalées.',
    color: 'cyan',
  },
  {
    icon: Rocket,
    title: 'Déploiement Instantané',
    description: 'Activez vos agents en quelques clics. Aucune configuration technique requise.',
    color: 'purple',
  },
  {
    icon: Lock,
    title: 'Sécurité Maximale',
    description: 'Vos données sont cryptées et protégées selon les normes RGPD les plus strictes.',
    color: 'pink',
  },
  {
    icon: RefreshCw,
    title: 'Apprentissage Continu',
    description: 'Les agents s\'améliorent automatiquement en apprenant de chaque interaction.',
    color: 'cyan',
  },
  {
    icon: Plug,
    title: 'Intégrations Natives',
    description: 'Connectez vos outils préférés : Slack, HubSpot, Salesforce, Zapier et plus.',
    color: 'purple',
  },
  {
    icon: LineChart,
    title: 'Analytics Avancés',
    description: 'Suivez les performances de chaque agent avec des tableaux de bord détaillés.',
    color: 'pink',
  },
  {
    icon: Clock,
    title: 'Disponibilité 24/7',
    description: 'Vos agents travaillent jour et nuit, week-ends et jours fériés inclus.',
    color: 'cyan',
  },
  {
    icon: Globe,
    title: 'Multi-Langue',
    description: 'Support de plus de 50 langues pour une portée internationale.',
    color: 'purple',
  },
]

export function Features() {
  return (
    <section id="features-section" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-card/50">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute bottom-0 right-0 w-[600px] h-[600px] bg-accent-cyan/10 rounded-full blur-[150px]" />
        <div className="absolute top-0 left-0 w-[400px] h-[400px] bg-accent-pink/10 rounded-full blur-[100px]" />
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
            <Cpu className="w-4 h-4 text-accent-purple" />
            <span className="text-sm font-medium text-foreground/80">Technologie Avancée</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Pourquoi </span>
            <span className="gradient-text-cyan-purple">Nous Choisir</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Une technologie de pointe combinée à une simplicité d'utilisation exceptionnelle.
          </p>
        </motion.div>

        {/* Features Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature, index) => {
            const Icon = feature.icon
            const colorMap = {
              cyan: 'text-accent-cyan bg-accent-cyan/10 border-accent-cyan/30',
              purple: 'text-accent-purple bg-accent-purple/10 border-accent-purple/30',
              pink: 'text-accent-pink bg-accent-pink/10 border-accent-pink/30',
            }
            const colors = colorMap[feature.color as keyof typeof colorMap]
            
            return (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className="futuristic-card p-6 text-center group"
              >
                <div className={`w-16 h-16 ${colors} rounded-2xl flex items-center justify-center mx-auto mb-4 border transition-all duration-300 group-hover:scale-110`}>
                  <Icon className="w-8 h-8" />
                </div>
                <h3 className="text-lg font-orbitron font-semibold text-foreground mb-3">
                  {feature.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            )
          })}
        </div>

        {/* Bottom Stats */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="mt-20 glass-effect rounded-2xl p-8"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {[
              { value: '500+', label: 'Entreprises' },
              { value: '1M+', label: 'Tâches Automatisées' },
              { value: '98%', label: 'Satisfaction Client' },
              { value: '<1s', label: 'Temps de Réponse' },
            ].map((stat, index) => (
              <div key={index} className="text-center">
                <div className="text-3xl sm:text-4xl font-orbitron font-bold gradient-text mb-2">
                  {stat.value}
                </div>
                <div className="text-muted-foreground">{stat.label}</div>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  )
}

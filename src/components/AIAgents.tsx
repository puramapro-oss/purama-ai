'use client'

import { motion } from 'framer-motion'
import { useState } from 'react'
import { 
  Bot, MessageSquare, TrendingUp, Users, Mail, Calendar,
  FileText, ShoppingCart, Headphones, BarChart3, Search,
  Megaphone, CreditCard, Globe, Briefcase, Shield, 
  Lightbulb, Zap, Target, Sparkles
} from 'lucide-react'

const agents = [
  {
    id: 1,
    name: 'Agent Marketing',
    description: 'Crée des campagnes marketing automatisées et personnalisées',
    icon: Megaphone,
    color: 'cyan',
    features: ['Création de contenu', 'A/B Testing', 'Analyse ROI'],
  },
  {
    id: 2,
    name: 'Agent Commercial',
    description: 'Qualifie les leads et automatise le processus de vente',
    icon: TrendingUp,
    color: 'purple',
    features: ['Lead scoring', 'Suivi automatique', 'Propositions'],
  },
  {
    id: 3,
    name: 'Agent Support',
    description: 'Répond aux clients 24/7 avec une précision exceptionnelle',
    icon: Headphones,
    color: 'pink',
    features: ['Chat en direct', 'FAQ intelligent', 'Escalade auto'],
  },
  {
    id: 4,
    name: 'Agent Email',
    description: 'Gère et personnalise vos campagnes email automatiquement',
    icon: Mail,
    color: 'cyan',
    features: ['Séquences auto', 'Segmentation', 'Optimisation'],
  },
  {
    id: 5,
    name: 'Agent RH',
    description: 'Automatise le recrutement et la gestion des talents',
    icon: Users,
    color: 'purple',
    features: ['Tri CV', 'Onboarding', 'Formation'],
  },
  {
    id: 6,
    name: 'Agent Planning',
    description: 'Optimise les plannings et gère les rendez-vous',
    icon: Calendar,
    color: 'pink',
    features: ['Réservation auto', 'Rappels', 'Optimisation'],
  },
  {
    id: 7,
    name: 'Agent Contenu',
    description: 'Génère du contenu de qualité pour tous vos besoins',
    icon: FileText,
    color: 'cyan',
    features: ['Articles SEO', 'Réseaux sociaux', 'Scripts'],
  },
  {
    id: 8,
    name: 'Agent E-commerce',
    description: 'Optimise votre boutique et booste vos ventes',
    icon: ShoppingCart,
    color: 'purple',
    features: ['Recommandations', 'Panier abandonné', 'Upsell'],
  },
  {
    id: 9,
    name: 'Agent Analytics',
    description: 'Analyse vos données et génère des insights actionnables',
    icon: BarChart3,
    color: 'pink',
    features: ['Rapports auto', 'Prédictions', 'Alertes'],
  },
  {
    id: 10,
    name: 'Agent SEO',
    description: 'Optimise votre référencement naturel automatiquement',
    icon: Search,
    color: 'cyan',
    features: ['Audit technique', 'Mots-clés', 'Backlinks'],
  },
  {
    id: 11,
    name: 'Agent Chatbot',
    description: 'Conversationnel intelligent pour votre site web',
    icon: MessageSquare,
    color: 'purple',
    features: ['Multi-langue', 'Personnalisé', 'Intégration CRM'],
  },
  {
    id: 12,
    name: 'Agent Finance',
    description: 'Automatise la comptabilité et les rapports financiers',
    icon: CreditCard,
    color: 'pink',
    features: ['Facturation', 'Suivi dépenses', 'Prévisions'],
  },
  {
    id: 13,
    name: 'Agent Social Media',
    description: 'Gère vos réseaux sociaux de A à Z',
    icon: Globe,
    color: 'cyan',
    features: ['Publication auto', 'Engagement', 'Analytics'],
  },
  {
    id: 14,
    name: 'Agent Projet',
    description: 'Coordonne vos projets et équipes efficacement',
    icon: Briefcase,
    color: 'purple',
    features: ['Tâches', 'Deadlines', 'Collaboration'],
  },
  {
    id: 15,
    name: 'Agent Sécurité',
    description: 'Protège votre entreprise contre les menaces',
    icon: Shield,
    color: 'pink',
    features: ['Surveillance', 'Alertes', 'Conformité'],
  },
  {
    id: 16,
    name: 'Agent Innovation',
    description: 'Génère des idées et analyse les tendances marché',
    icon: Lightbulb,
    color: 'cyan',
    features: ['Veille', 'Brainstorming', 'R&D'],
  },
  {
    id: 17,
    name: 'Agent Productivité',
    description: 'Optimise les workflows et élimine les tâches répétitives',
    icon: Zap,
    color: 'purple',
    features: ['Automatisation', 'Templates', 'Intégrations'],
  },
  {
    id: 18,
    name: 'Agent Publicité',
    description: 'Gère vos campagnes publicitaires multi-plateformes',
    icon: Target,
    color: 'pink',
    features: ['Google Ads', 'Meta Ads', 'Optimisation'],
  },
  {
    id: 19,
    name: 'Agent IA Pro',
    description: 'Assistant personnel ultra-intelligent et polyvalent',
    icon: Bot,
    color: 'cyan',
    features: ['Multi-tâches', 'Apprentissage', 'Personnalisé'],
  },
  {
    id: 20,
    name: 'Agent Premium',
    description: 'Solution complète avec tous les agents intégrés',
    icon: Sparkles,
    color: 'purple',
    features: ['Tout inclus', 'Support VIP', 'Custom'],
  },
]

const colorClasses = {
  cyan: {
    bg: 'bg-accent-cyan/10',
    border: 'border-accent-cyan/30',
    text: 'text-accent-cyan',
    glow: 'hover:shadow-[0_0_30px_rgba(0,240,255,0.3)]',
    icon: 'text-accent-cyan',
  },
  purple: {
    bg: 'bg-accent-purple/10',
    border: 'border-accent-purple/30',
    text: 'text-accent-purple',
    glow: 'hover:shadow-[0_0_30px_rgba(124,58,237,0.3)]',
    icon: 'text-accent-purple',
  },
  pink: {
    bg: 'bg-accent-pink/10',
    border: 'border-accent-pink/30',
    text: 'text-accent-pink',
    glow: 'hover:shadow-[0_0_30px_rgba(244,114,182,0.3)]',
    icon: 'text-accent-pink',
  },
}

export function AIAgents() {
  const [hoveredAgent, setHoveredAgent] = useState<number | null>(null)

  return (
    <section id="agents" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-background">
        <div className="absolute inset-0 grid-pattern opacity-30" />
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] bg-accent-purple/10 rounded-full blur-[120px]" />
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
            <Bot className="w-4 h-4 text-accent-cyan" />
            <span className="text-sm font-medium text-foreground/80">45 Agents Spécialisés</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Nos </span>
            <span className="gradient-text">Agents IA</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Chaque agent est conçu pour exceller dans son domaine et s'intégrer parfaitement à votre workflow.
          </p>
        </motion.div>

        {/* Agents Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {agents.map((agent, index) => {
            const colors = colorClasses[agent.color as keyof typeof colorClasses]
            const Icon = agent.icon
            
            return (
              <motion.div
                key={agent.id}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: index * 0.05 }}
                onMouseEnter={() => setHoveredAgent(agent.id)}
                onMouseLeave={() => setHoveredAgent(null)}
                className={`
                  futuristic-card p-6 cursor-pointer
                  ${colors.glow}
                  ${hoveredAgent === agent.id ? 'border-opacity-100' : ''}
                `}
              >
                {/* Icon */}
                <div className={`w-14 h-14 ${colors.bg} rounded-xl flex items-center justify-center mb-4 ${colors.border} border`}>
                  <Icon className={`w-7 h-7 ${colors.icon}`} />
                </div>

                {/* Content */}
                <h3 className="text-lg font-orbitron font-semibold text-foreground mb-2">
                  {agent.name}
                </h3>
                <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
                  {agent.description}
                </p>

                {/* Features */}
                <div className="flex flex-wrap gap-2">
                  {agent.features.map((feature, i) => (
                    <span 
                      key={i}
                      className={`text-xs ${colors.bg} ${colors.text} px-2 py-1 rounded-full ${colors.border} border`}
                    >
                      {feature}
                    </span>
                  ))}
                </div>

                {/* Hover indicator */}
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: hoveredAgent === agent.id ? '100%' : 0 }}
                  className={`h-0.5 ${colors.text} bg-current mt-4 rounded-full`}
                />
              </motion.div>
            )
          })}
        </div>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="text-center mt-16"
        >
          <button 
            onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
            className="btn-primary text-lg px-10 py-4"
          >
            Demander une Démo
          </button>
        </motion.div>
      </div>
    </section>
  )
}

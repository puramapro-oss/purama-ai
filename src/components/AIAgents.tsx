'use client'

import { motion } from 'framer-motion'
import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { 
  Bot, MessageSquare, TrendingUp, Users, Mail, Calendar,
  FileText, ShoppingCart, Headphones, BarChart3, Search,
  Megaphone, CreditCard, Globe, Briefcase, Shield, 
  Lightbulb, Zap, Target, Sparkles, LucideIcon, Loader2,
  Scale, CheckCircle, Plane, Brain, LineChart, PenTool,
  Image, Video, Music, Database, Code, Settings, Heart,
  Award, BookOpen, Rocket, Clock, MapPin, Phone, AlertTriangle,
  ArrowRight, ChevronDown, ChevronUp
} from 'lucide-react'
import { supabase } from '@/integrations/supabase/client'
import { Json } from '@/integrations/supabase/types'

interface Agent {
  id: string
  name: string
  slug: string
  description: string | null
  icon: string | null
  color: string | null
  features: Json | null
  category: string
  is_premium: boolean | null
}

const iconMap: Record<string, LucideIcon> = {
  '⚖️': Scale, '⚡': Zap, '✅': CheckCircle, '✈️': Plane, '🧠': Brain,
  '📊': BarChart3, '📈': LineChart, '📝': FileText, '🎨': PenTool,
  '🖼️': Image, '🎬': Video, '🎵': Music, '💾': Database, '💻': Code,
  '⚙️': Settings, '❤️': Heart, '🏆': Award, '📚': BookOpen, '🚀': Rocket,
  '⏰': Clock, '📍': MapPin, '📞': Phone, '⚠️': AlertTriangle, '📧': Mail,
  '💬': MessageSquare, '📢': Megaphone, '🛒': ShoppingCart, '🎧': Headphones,
  '🔍': Search, '🌐': Globe, '💼': Briefcase, '🛡️': Shield, '💡': Lightbulb,
  '🎯': Target, '✨': Sparkles, '👥': Users, '📅': Calendar, '💳': CreditCard,
  '🤖': Bot,
}

// Generate a deterministic profile avatar URL from agent slug
const getAgentAvatar = (slug: string, index: number): string => {
  const styles = ['bottts', 'shapes', 'identicon']
  const style = styles[index % styles.length]
  return `https://api.dicebear.com/9.x/${style}/svg?seed=${slug}&backgroundColor=0a0a1f&radius=50`
}

const getColorTheme = (hexColor: string | null): 'cyan' | 'purple' | 'pink' => {
  if (!hexColor) return 'cyan'
  const hex = hexColor.replace('#', '')
  const r = parseInt(hex.substring(0, 2), 16)
  const g = parseInt(hex.substring(2, 4), 16)
  const b = parseInt(hex.substring(4, 6), 16)
  if (b > r && b > g) return 'cyan'
  if (r > b && r > g * 1.2) return 'pink'
  return 'purple'
}

const colorClasses = {
  cyan: {
    bg: 'bg-accent-cyan/10', border: 'border-accent-cyan/30',
    text: 'text-accent-cyan', glow: 'hover:shadow-[0_0_30px_rgba(0,240,255,0.3)]',
    ring: 'ring-accent-cyan/40',
  },
  purple: {
    bg: 'bg-accent-purple/10', border: 'border-accent-purple/30',
    text: 'text-accent-purple', glow: 'hover:shadow-[0_0_30px_rgba(124,58,237,0.3)]',
    ring: 'ring-accent-purple/40',
  },
  pink: {
    bg: 'bg-accent-pink/10', border: 'border-accent-pink/30',
    text: 'text-accent-pink', glow: 'hover:shadow-[0_0_30px_rgba(244,114,182,0.3)]',
    ring: 'ring-accent-pink/40',
  },
}

const INITIAL_DISPLAY_COUNT = 8

export function AIAgents() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    async function fetchAgents() {
      const { data, error } = await supabase
        .from('agents')
        .select('id, name, slug, description, icon, color, features, category, is_premium')
        .eq('is_active', true)
        .order('name')

      if (!error) setAgents(data || [])
      setIsLoading(false)
    }
    fetchAgents()
  }, [])

  const getIcon = (iconEmoji: string | null): LucideIcon => {
    if (!iconEmoji) return Bot
    return iconMap[iconEmoji] || Bot
  }

  const displayedAgents = showAll ? agents : agents.slice(0, INITIAL_DISPLAY_COUNT)
  const remainingCount = agents.length - INITIAL_DISPLAY_COUNT

  return (
    <section id="agents-section" className="relative py-24 overflow-hidden">
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
            <span className="text-sm font-medium text-foreground/80">{agents.length} Agents Spécialisés</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Vos </span>
            <span className="gradient-text">Agents IA</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Chaque agent est un expert dans son domaine, prêt à transformer votre productivité.
          </p>
        </motion.div>

        {/* Loading */}
        {isLoading && (
          <div className="flex justify-center items-center py-20">
            <Loader2 className="w-10 h-10 text-accent-cyan animate-spin" />
          </div>
        )}

        {/* Agents Grid */}
        {!isLoading && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
              {displayedAgents.map((agent, index) => {
                const colorTheme = getColorTheme(agent.color)
                const colors = colorClasses[colorTheme]
                const Icon = getIcon(agent.icon)
                
                return (
                  <Link to={`/agent/${agent.slug}`} key={agent.id}>
                    <motion.div
                      initial={{ opacity: 0, y: 30 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5, delay: Math.min(index * 0.05, 0.4) }}
                      whileHover={{ y: -8, transition: { duration: 0.3 } }}
                      className={`futuristic-card p-6 cursor-pointer relative h-full group ${colors.glow}`}
                    >
                      {/* Premium Badge */}
                      {agent.is_premium && (
                        <div className="absolute top-3 right-3">
                          <span className="text-xs bg-accent-purple/20 text-accent-purple px-2 py-1 rounded-full border border-accent-purple/30 font-semibold">
                            Premium
                          </span>
                        </div>
                      )}

                      {/* Avatar + Icon row */}
                      <div className="flex items-center gap-4 mb-4">
                        <div className={`relative w-14 h-14 rounded-full overflow-hidden ring-2 ${colors.ring} flex-shrink-0`}>
                          <img 
                            src={getAgentAvatar(agent.slug, index)} 
                            alt={`Avatar ${agent.name}`}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                          <div className={`absolute bottom-0 right-0 w-5 h-5 ${colors.bg} rounded-full flex items-center justify-center border border-card`}>
                            <Icon className={`w-3 h-3 ${colors.text}`} />
                          </div>
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-base font-orbitron font-semibold text-foreground truncate group-hover:text-accent-cyan transition-colors">
                            {agent.name}
                          </h3>
                          <span className={`text-xs ${colors.text} font-medium`}>{agent.category}</span>
                        </div>
                      </div>

                      {/* Description */}
                      <p className="text-sm text-muted-foreground mb-4 leading-relaxed line-clamp-2">
                        {agent.description}
                      </p>

                      {/* View details */}
                      <div className={`flex items-center gap-2 text-sm ${colors.text} opacity-0 group-hover:opacity-100 transition-opacity duration-300`}>
                        <span>Découvrir</span>
                        <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                      </div>
                    </motion.div>
                  </Link>
                )
              })}
            </div>

            {/* Show More/Less */}
            {agents.length > INITIAL_DISPLAY_COUNT && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                className="flex justify-center mt-12"
              >
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setShowAll(!showAll)}
                  className="group flex items-center gap-3 glass-effect px-8 py-4 rounded-full border border-accent-cyan/30 hover:border-accent-cyan/60 transition-all duration-300 hover:shadow-[0_0_30px_rgba(0,240,255,0.2)]"
                >
                  {showAll ? (
                    <>
                      <ChevronUp className="w-5 h-5 text-accent-cyan" />
                      <span className="text-foreground font-medium">Voir moins</span>
                    </>
                  ) : (
                    <>
                      <span className="text-foreground font-medium">
                        Voir les {remainingCount} autres agents
                      </span>
                      <ChevronDown className="w-5 h-5 text-accent-cyan" />
                    </>
                  )}
                </motion.button>
              </motion.div>
            )}
          </>
        )}

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="text-center mt-16"
        >
          <motion.button 
            whileHover={{ scale: 1.05, boxShadow: '0 0 50px rgba(0, 240, 255, 0.4)' }}
            whileTap={{ scale: 0.95 }}
            onClick={() => document.getElementById('contact-section')?.scrollIntoView({ behavior: 'smooth' })}
            className="btn-primary text-lg px-10 py-4"
          >
            Demander une Démo Gratuite
          </motion.button>
        </motion.div>
      </div>
    </section>
  )
}

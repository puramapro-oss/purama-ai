'use client'

import { motion, AnimatePresence } from 'framer-motion'
import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Bot, MessageSquare, TrendingUp, Users, Mail, Calendar,
  FileText, ShoppingCart, Headphones, BarChart3, Search,
  Megaphone, CreditCard, Globe, Briefcase, Shield,
  Lightbulb, Zap, Target, Sparkles, LucideIcon, Loader2,
  Scale, CheckCircle, Plane, Brain, LineChart, PenTool,
  Image, Video, Music, Database, Code, Settings, Heart,
  Award, BookOpen, Rocket, Clock, MapPin, Phone, AlertTriangle,
  ArrowRight, ChevronDown, ChevronUp, Play, X, Send
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

// Demo conversation data for each agent category
const demoConversations: Record<string, { user: string; bot: string }[]> = {
  default: [
    { user: "Bonjour, comment pouvez-vous m'aider ?", bot: "Je suis votre assistant IA spécialisé. Je peux automatiser vos tâches répétitives, analyser vos données et vous faire gagner des heures chaque jour. Que souhaitez-vous automatiser ?" },
    { user: "Je perds beaucoup de temps sur les emails", bot: "Je peux trier, répondre et prioriser vos emails automatiquement. En moyenne, mes utilisateurs gagnent 2h/jour. Voulez-vous que je configure ça pour vous ?" },
    { user: "Oui, montrez-moi !", bot: "Parfait ! Pour activer cette fonctionnalité complète, choisissez un abonnement et accédez à votre Dashboard personnalisé. Tout sera configuré en 2 minutes." },
  ],
  'Marketing': [
    { user: "J'ai besoin d'aide pour mes campagnes marketing", bot: "Je gère vos campagnes de A à Z : création de contenu, ciblage, A/B testing, et optimisation en temps réel. Mes utilisateurs voient +47% de ROI en moyenne." },
    { user: "Vous pouvez créer du contenu automatiquement ?", bot: "Absolument ! Posts réseaux sociaux, newsletters, landing pages... Je génère du contenu optimisé pour chaque plateforme et j'analyse les performances en direct." },
    { user: "Impressionnant, je veux essayer !", bot: "Choisissez votre abonnement et en 2 minutes votre agent marketing sera actif dans votre Dashboard. Résultats visibles dès la première semaine !" },
  ],
  'Ventes': [
    { user: "Comment booster mes ventes ?", bot: "J'analyse votre pipeline, identifie les leads chauds et automatise vos relances. Résultat moyen : +35% de conversions en 30 jours." },
    { user: "Vous pouvez qualifier mes leads ?", bot: "Oui ! Je score chaque lead selon 15 critères, priorise les meilleurs et prépare des messages personnalisés. Vos commerciaux ne perdent plus de temps." },
    { user: "Parfait, on commence quand ?", bot: "Dès votre inscription ! Choisissez un plan, accédez au Dashboard et votre agent commercial sera opérationnel en moins de 5 minutes." },
  ],
  'Support': [
    { user: "Mon support client est débordé", bot: "Je prends en charge 80% des demandes récurrentes instantanément. Temps de réponse moyen : 3 secondes. Vos clients sont satisfaits, votre équipe respire." },
    { user: "Et les cas complexes ?", bot: "Je les escalade intelligemment à votre équipe avec un résumé complet et des suggestions de solution. Rien ne passe entre les mailles du filet." },
    { user: "C'est exactement ce qu'il me faut", bot: "Activez votre agent support en choisissant un abonnement. Dashboard intuitif, mise en place en 2 minutes, résultats immédiats." },
  ],
}

const INITIAL_DISPLAY_COUNT = 8

export function AIAgents() {
  const navigate = useNavigate()
  const [agents, setAgents] = useState<Agent[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)
  const [demoAgent, setDemoAgent] = useState<Agent | null>(null)
  const [demoStep, setDemoStep] = useState(0)
  const [isTyping, setIsTyping] = useState(false)
  const [displayedMessages, setDisplayedMessages] = useState<{ role: 'user' | 'bot'; text: string }[]>([])

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

  const startDemo = (agent: Agent) => {
    setDemoAgent(agent)
    setDemoStep(0)
    setDisplayedMessages([])
    setIsTyping(false)

    // Start the conversation automatically
    const convo = demoConversations[agent.category] || demoConversations.default
    setTimeout(() => {
      setDisplayedMessages([{ role: 'user', text: convo[0].user }])
      setIsTyping(true)
      setTimeout(() => {
        setIsTyping(false)
        setDisplayedMessages(prev => [...prev, { role: 'bot', text: convo[0].bot }])
        setDemoStep(1)
      }, 1500)
    }, 500)
  }

  const advanceDemo = () => {
    const convo = demoConversations[demoAgent?.category || ''] || demoConversations.default
    if (demoStep >= convo.length) return

    setDisplayedMessages(prev => [...prev, { role: 'user', text: convo[demoStep].user }])
    setIsTyping(true)
    setTimeout(() => {
      setIsTyping(false)
      setDisplayedMessages(prev => [...prev, { role: 'bot', text: convo[demoStep].bot }])
      setDemoStep(prev => prev + 1)
    }, 1500)
  }

  const displayedAgents = showAll ? agents : agents.slice(0, INITIAL_DISPLAY_COUNT)
  const remainingCount = agents.length - INITIAL_DISPLAY_COUNT
  const convo = demoConversations[demoAgent?.category || ''] || demoConversations.default

  return (
    <>
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
                    <motion.div
                      key={agent.id}
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

                      {/* Demo button */}
                      <button
                        onClick={() => startDemo(agent)}
                        className={`flex items-center gap-2 text-sm ${colors.text} font-medium opacity-0 group-hover:opacity-100 transition-all duration-300 hover:underline`}
                      >
                        <Play className="w-4 h-4" />
                        <span>Tester la démo</span>
                      </button>
                    </motion.div>
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

          {/* CTA - Percutant */}
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="text-center mt-16"
          >
            <motion.button
              whileHover={{ scale: 1.05, boxShadow: '0 0 60px rgba(0, 240, 255, 0.5)' }}
              whileTap={{ scale: 0.95 }}
              onClick={() => navigate('/pricing')}
              className="btn-primary text-lg px-10 py-5 font-bold relative overflow-hidden group"
            >
              <span className="relative z-10 flex items-center gap-3">
                <Rocket className="w-6 h-6" />
                Activer Mes Agents IA
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </span>
              <div className="absolute inset-0 bg-gradient-to-r from-accent-cyan/20 to-accent-purple/20 opacity-0 group-hover:opacity-100 transition-opacity" />
            </motion.button>
            <p className="text-muted-foreground text-sm mt-3">14 jours d'essai gratuit — Sans engagement</p>
          </motion.div>
        </div>
      </section>

      {/* Demo Modal */}
      <AnimatePresence>
        {demoAgent && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-background/90 backdrop-blur-md" onClick={() => setDemoAgent(null)} />

            {/* Modal */}
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full max-w-lg bg-card border border-accent-cyan/30 rounded-2xl shadow-[0_0_60px_rgba(0,240,255,0.15)] overflow-hidden"
            >
              {/* Modal Header */}
              <div className="flex items-center justify-between p-4 border-b border-border bg-gradient-to-r from-accent-cyan/5 to-accent-purple/5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple flex items-center justify-center">
                    <Bot className="w-5 h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="font-orbitron font-bold text-foreground text-sm">{demoAgent.name}</h3>
                    <p className="text-xs text-accent-cyan">Demo en direct</p>
                  </div>
                </div>
                <button onClick={() => setDemoAgent(null)} className="p-2 rounded-full hover:bg-secondary/50 text-muted-foreground">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Chat area */}
              <div className="p-4 space-y-4 min-h-[300px] max-h-[400px] overflow-y-auto">
                {displayedMessages.map((msg, i) => (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === 'user'
                        ? 'bg-gradient-to-r from-accent-cyan to-accent-purple text-white rounded-br-sm'
                        : 'bg-secondary/50 text-foreground/90 border border-border rounded-bl-sm'
                    }`}>
                      {msg.text}
                    </div>
                  </motion.div>
                ))}

                {/* Typing indicator */}
                {isTyping && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex justify-start"
                  >
                    <div className="bg-secondary/50 border border-border rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5">
                      <span className="w-2 h-2 bg-accent-cyan rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-accent-cyan rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-accent-cyan rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </motion.div>
                )}
              </div>

              {/* Action area */}
              <div className="p-4 border-t border-border">
                {demoStep < convo.length && !isTyping ? (
                  <button
                    onClick={advanceDemo}
                    className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-secondary/50 hover:bg-secondary/80 text-foreground text-sm font-medium transition-all border border-border"
                  >
                    <Send className="w-4 h-4 text-accent-cyan" />
                    Continuer la conversation
                  </button>
                ) : demoStep >= convo.length && !isTyping ? (
                  <motion.button
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    onClick={() => { setDemoAgent(null); navigate('/pricing'); }}
                    className="w-full py-3.5 rounded-xl btn-primary font-bold text-sm flex items-center justify-center gap-2"
                  >
                    <Rocket className="w-4 h-4" />
                    Activer cet Agent — Choisir mon Plan
                    <ArrowRight className="w-4 h-4" />
                  </motion.button>
                ) : (
                  <div className="text-center text-xs text-muted-foreground py-2">
                    L'agent est en train de répondre...
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

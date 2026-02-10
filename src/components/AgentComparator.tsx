'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { 
  BarChart2, Check, X, Star, Zap, Clock, Shield, 
  TrendingUp, Users, Megaphone, Search, Brain, 
  DollarSign, Target, Mail, Share2, Database, FileText,
  Briefcase, HeadphonesIcon, Sparkles, Scale, ShoppingCart, PieChart
} from 'lucide-react'

const agents = [
  { id: 1, name: 'Marketing IA', icon: Megaphone, category: 'Marketing', price: 49, automation: 85, speed: 'Rapide', support: true, integration: 15, rating: 4.9 },
  { id: 2, name: 'SEO IA', icon: Search, category: 'Marketing', price: 39, automation: 90, speed: 'Rapide', support: true, integration: 12, rating: 4.8 },
  { id: 3, name: 'RH IA', icon: Users, category: 'RH', price: 59, automation: 75, speed: 'Modéré', support: true, integration: 8, rating: 4.7 },
  { id: 4, name: 'Finance IA', icon: DollarSign, category: 'Finance', price: 79, automation: 95, speed: 'Ultra-rapide', support: true, integration: 20, rating: 4.9 },
  { id: 5, name: 'Ventes IA', icon: Target, category: 'Ventes', price: 69, automation: 88, speed: 'Rapide', support: true, integration: 18, rating: 4.8 },
  { id: 6, name: 'Support IA', icon: HeadphonesIcon, category: 'Support', price: 49, automation: 92, speed: 'Instantané', support: true, integration: 25, rating: 4.9 },
  { id: 7, name: 'Email IA', icon: Mail, category: 'Marketing', price: 29, automation: 95, speed: 'Ultra-rapide', support: true, integration: 10, rating: 4.6 },
  { id: 8, name: 'Social Media IA', icon: Share2, category: 'Marketing', price: 45, automation: 85, speed: 'Rapide', support: true, integration: 12, rating: 4.7 },
  { id: 9, name: 'Data IA', icon: Database, category: 'Analytics', price: 89, automation: 98, speed: 'Rapide', support: true, integration: 30, rating: 4.9 },
  { id: 10, name: 'Content IA', icon: FileText, category: 'Marketing', price: 55, automation: 80, speed: 'Modéré', support: true, integration: 8, rating: 4.7 },
  { id: 11, name: 'Juridique IA', icon: Scale, category: 'Légal', price: 99, automation: 70, speed: 'Modéré', support: true, integration: 5, rating: 4.5 },
  { id: 12, name: 'E-commerce IA', icon: ShoppingCart, category: 'Ventes', price: 75, automation: 90, speed: 'Rapide', support: true, integration: 22, rating: 4.8 },
  { id: 13, name: 'Analytics IA', icon: PieChart, category: 'Analytics', price: 65, automation: 95, speed: 'Ultra-rapide', support: true, integration: 25, rating: 4.9 },
  { id: 14, name: 'Recrutement IA', icon: Briefcase, category: 'RH', price: 69, automation: 82, speed: 'Rapide', support: true, integration: 10, rating: 4.6 },
  { id: 15, name: 'Stratégie IA', icon: Brain, category: 'Management', price: 129, automation: 65, speed: 'Modéré', support: true, integration: 15, rating: 4.8 },
]

const categories = ['Tous', 'Marketing', 'Ventes', 'RH', 'Finance', 'Analytics', 'Support', 'Légal', 'Management']

export function AgentComparator() {
  const [selectedCategory, setSelectedCategory] = useState('Tous')
  const [selectedAgents, setSelectedAgents] = useState<number[]>([])
  const [sortBy, setSortBy] = useState<'price' | 'automation' | 'rating'>('rating')

  const filteredAgents = agents
    .filter(agent => selectedCategory === 'Tous' || agent.category === selectedCategory)
    .sort((a, b) => {
      if (sortBy === 'price') return a.price - b.price
      if (sortBy === 'automation') return b.automation - a.automation
      return b.rating - a.rating
    })

  const toggleAgent = (id: number) => {
    setSelectedAgents(prev => 
      prev.includes(id) 
        ? prev.filter(a => a !== id)
        : prev.length < 3 ? [...prev, id] : prev
    )
  }

  const comparisonAgents = agents.filter(a => selectedAgents.includes(a.id))

  return (
    <section id="comparator" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-background">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-accent-pink/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-1/4 left-0 w-[400px] h-[400px] bg-accent-cyan/10 rounded-full blur-[100px]" />
      </div>

      <div className="container mx-auto px-6 sm:px-8 lg:px-12 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.8 }}
          className="text-center mb-12"
        >
          <div className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-6">
            <BarChart2 className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-medium text-foreground/80">Comparateur d'Agents</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Comparez Nos </span>
            <span className="gradient-text">Agents IA</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Sélectionnez jusqu'à 3 agents pour les comparer côte à côte.
          </p>
        </motion.div>

        {/* Filters */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="flex flex-wrap justify-center gap-3 mb-8"
        >
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
                selectedCategory === cat
                  ? 'bg-gradient-to-r from-accent-cyan to-accent-purple text-white'
                  : 'glass-effect text-foreground/70 hover:text-foreground'
              }`}
            >
              {cat}
            </button>
          ))}
        </motion.div>

        {/* Sort Options */}
        <div className="flex justify-center gap-4 mb-8">
          <span className="text-muted-foreground text-sm">Trier par:</span>
          {[
            { key: 'rating', label: 'Note' },
            { key: 'automation', label: 'Automatisation' },
            { key: 'price', label: 'Prix' },
          ].map((option) => (
            <button
              key={option.key}
              onClick={() => setSortBy(option.key as typeof sortBy)}
              className={`text-sm transition-colors ${
                sortBy === option.key ? 'text-accent-cyan' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {/* Agents Grid */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4 mb-12"
        >
          {filteredAgents.map((agent, index) => {
            const isSelected = selectedAgents.includes(agent.id)
            return (
              <motion.button
                key={agent.id}
                initial={{ opacity: 0, scale: 0.9 }}
                whileInView={{ opacity: 1, scale: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.3, delay: index * 0.05 }}
                onClick={() => toggleAgent(agent.id)}
                className={`relative p-4 rounded-xl text-left transition-all min-h-[100px] ${
                  isSelected
                    ? 'bg-gradient-to-br from-accent-cyan/20 to-accent-purple/20 border-2 border-accent-cyan'
                    : 'futuristic-card hover:border-accent-cyan/50'
                }`}
              >
                {isSelected && (
                  <div className="absolute top-2 right-2 w-5 h-5 bg-accent-cyan rounded-full flex items-center justify-center">
                    <Check className="w-3 h-3 text-white" />
                  </div>
                )}
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center mb-3 ${
                  isSelected ? 'bg-accent-cyan/20' : 'bg-secondary'
                }`}>
                  <agent.icon className={`w-5 h-5 ${isSelected ? 'text-accent-cyan' : 'text-foreground/70'}`} />
                </div>
                <h4 className="font-semibold text-sm text-foreground mb-1">{agent.name}</h4>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
                  {agent.rating}
                </div>
                <div className="text-accent-cyan font-orbitron text-sm mt-2">{agent.price}€/mois</div>
              </motion.button>
            )
          })}
        </motion.div>

        {/* Comparison Table */}
        {comparisonAgents.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="futuristic-card overflow-hidden"
          >
            <div className="p-6 border-b border-accent-cyan/20">
              <h3 className="font-orbitron font-bold text-foreground flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-accent-cyan" />
                Comparaison
              </h3>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-accent-cyan/20">
                    <th className="text-left p-4 text-muted-foreground font-medium">Caractéristique</th>
                    {comparisonAgents.map(agent => (
                      <th key={agent.id} className="p-4 text-center">
                        <div className="flex flex-col items-center gap-2">
                          <div className="w-12 h-12 bg-gradient-to-br from-accent-cyan/20 to-accent-purple/20 rounded-xl flex items-center justify-center">
                            <agent.icon className="w-6 h-6 text-accent-cyan" />
                          </div>
                          <span className="font-semibold text-foreground">{agent.name}</span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-secondary">
                    <td className="p-4 text-foreground">Prix mensuel</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center font-orbitron text-accent-cyan">{agent.price}€</td>
                    ))}
                  </tr>
                  <tr className="border-b border-secondary">
                    <td className="p-4 text-foreground">Taux d'automatisation</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <div className="w-16 h-2 bg-secondary rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-accent-cyan to-accent-purple" style={{ width: `${agent.automation}%` }} />
                          </div>
                          <span className="text-sm text-foreground">{agent.automation}%</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-secondary">
                    <td className="p-4 text-foreground">Vitesse</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center">
                        <span className={`px-3 py-1 rounded-full text-xs ${
                          agent.speed === 'Ultra-rapide' || agent.speed === 'Instantané'
                            ? 'bg-green-500/20 text-green-400'
                            : agent.speed === 'Rapide'
                            ? 'bg-accent-cyan/20 text-accent-cyan'
                            : 'bg-yellow-500/20 text-yellow-400'
                        }`}>
                          {agent.speed}
                        </span>
                      </td>
                    ))}
                  </tr>
                  <tr className="border-b border-secondary">
                    <td className="p-4 text-foreground">Intégrations</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center text-foreground">{agent.integration}+</td>
                    ))}
                  </tr>
                  <tr className="border-b border-secondary">
                    <td className="p-4 text-foreground">Support 24/7</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center">
                        {agent.support ? (
                          <Check className="w-5 h-5 text-green-400 mx-auto" />
                        ) : (
                          <X className="w-5 h-5 text-red-400 mx-auto" />
                        )}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="p-4 text-foreground">Note</td>
                    {comparisonAgents.map(agent => (
                      <td key={agent.id} className="p-4 text-center">
                        <div className="flex items-center justify-center gap-1">
                          <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
                          <span className="text-foreground font-semibold">{agent.rating}</span>
                        </div>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            
            <div className="p-6 border-t border-accent-cyan/20 flex justify-center">
              <button
                onClick={() => document.getElementById('contact-section')?.scrollIntoView({ behavior: 'smooth' })}
                className="btn-primary"
              >
                Demander une Démo
              </button>
            </div>
          </motion.div>
        )}
      </div>
    </section>
  )
}

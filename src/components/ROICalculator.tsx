'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { Calculator, TrendingUp, Clock, Users, DollarSign, Zap } from 'lucide-react'

export function ROICalculator() {
  const [employees, setEmployees] = useState(10)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [avgSalary, setAvgSalary] = useState(3500)
  const [automationRate, setAutomationRate] = useState(30)

  // Calculs ROI
  const hourlyRate = avgSalary / (hoursPerWeek * 4.33)
  const hoursAutomated = hoursPerWeek * (automationRate / 100)
  const weeklyTimeSaved = employees * hoursAutomated
  const monthlySavings = weeklyTimeSaved * 4.33 * hourlyRate
  const yearlySavings = monthlySavings * 12
  const agentCost = employees <= 10 ? 299 : employees <= 25 ? 799 : 1499
  const yearlyInvestment = agentCost * 12
  const netROI = yearlySavings - yearlyInvestment
  const roiPercentage = ((yearlySavings - yearlyInvestment) / yearlyInvestment) * 100

  const stats = [
    { icon: Clock, label: 'Heures économisées/mois', value: `${Math.round(weeklyTimeSaved * 4.33)}h`, color: 'cyan' },
    { icon: DollarSign, label: 'Économies mensuelles', value: `${Math.round(monthlySavings).toLocaleString()}€`, color: 'purple' },
    { icon: TrendingUp, label: 'ROI annuel', value: `${Math.round(roiPercentage)}%`, color: 'pink' },
    { icon: Zap, label: 'Gain net/an', value: `${Math.round(netROI).toLocaleString()}€`, color: 'cyan' },
  ]

  const colorClasses = {
    cyan: { bg: 'bg-accent-cyan/10', text: 'text-accent-cyan', border: 'border-accent-cyan/30' },
    purple: { bg: 'bg-accent-purple/10', text: 'text-accent-purple', border: 'border-accent-purple/30' },
    pink: { bg: 'bg-accent-pink/10', text: 'text-accent-pink', border: 'border-accent-pink/30' },
  }

  return (
    <section id="roi-calculator" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-card/30">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute top-1/4 left-0 w-[500px] h-[500px] bg-accent-purple/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-[400px] h-[400px] bg-accent-cyan/10 rounded-full blur-[100px]" />
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
            <Calculator className="w-4 h-4 text-accent-purple" />
            <span className="text-sm font-medium text-foreground/80">Calculateur de ROI</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Calculez Vos </span>
            <span className="gradient-text">Économies</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Estimez le retour sur investissement de nos agents IA pour votre entreprise.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-12 max-w-6xl mx-auto">
          {/* Sliders */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="space-y-8"
          >
            <div className="futuristic-card p-8 space-y-8">
              {/* Employees */}
              <div>
                <div className="flex justify-between mb-3">
                  <label className="flex items-center gap-2 text-foreground font-medium">
                    <Users className="w-4 h-4 text-accent-cyan" />
                    Nombre d'employés
                  </label>
                  <span className="text-accent-cyan font-orbitron">{employees}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="100"
                  value={employees}
                  onChange={(e) => setEmployees(Number(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent-cyan"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>1</span>
                  <span>100</span>
                </div>
              </div>

              {/* Hours per week */}
              <div>
                <div className="flex justify-between mb-3">
                  <label className="flex items-center gap-2 text-foreground font-medium">
                    <Clock className="w-4 h-4 text-accent-purple" />
                    Heures de travail / semaine
                  </label>
                  <span className="text-accent-purple font-orbitron">{hoursPerWeek}h</span>
                </div>
                <input
                  type="range"
                  min="20"
                  max="60"
                  value={hoursPerWeek}
                  onChange={(e) => setHoursPerWeek(Number(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent-purple"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>20h</span>
                  <span>60h</span>
                </div>
              </div>

              {/* Avg Salary */}
              <div>
                <div className="flex justify-between mb-3">
                  <label className="flex items-center gap-2 text-foreground font-medium">
                    <DollarSign className="w-4 h-4 text-accent-pink" />
                    Salaire moyen mensuel (€)
                  </label>
                  <span className="text-accent-pink font-orbitron">{avgSalary.toLocaleString()}€</span>
                </div>
                <input
                  type="range"
                  min="2000"
                  max="10000"
                  step="100"
                  value={avgSalary}
                  onChange={(e) => setAvgSalary(Number(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent-pink"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>2 000€</span>
                  <span>10 000€</span>
                </div>
              </div>

              {/* Automation Rate */}
              <div>
                <div className="flex justify-between mb-3">
                  <label className="flex items-center gap-2 text-foreground font-medium">
                    <Zap className="w-4 h-4 text-accent-cyan" />
                    Taux d'automatisation potentiel
                  </label>
                  <span className="text-accent-cyan font-orbitron">{automationRate}%</span>
                </div>
                <input
                  type="range"
                  min="10"
                  max="70"
                  value={automationRate}
                  onChange={(e) => setAutomationRate(Number(e.target.value))}
                  className="w-full h-2 bg-secondary rounded-lg appearance-none cursor-pointer accent-accent-cyan"
                />
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>10%</span>
                  <span>70%</span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* Results */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="space-y-6"
          >
            {/* Stats Grid */}
            <div className="grid grid-cols-2 gap-4">
              {stats.map((stat, index) => {
                const colors = colorClasses[stat.color as keyof typeof colorClasses]
                return (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, scale: 0.9 }}
                    whileInView={{ opacity: 1, scale: 1 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className={`futuristic-card p-6 text-center border ${colors.border}`}
                  >
                    <div className={`w-12 h-12 ${colors.bg} rounded-xl flex items-center justify-center mx-auto mb-3`}>
                      <stat.icon className={`w-6 h-6 ${colors.text}`} />
                    </div>
                    <div className={`text-2xl font-orbitron font-bold ${colors.text} mb-1`}>
                      {stat.value}
                    </div>
                    <div className="text-sm text-muted-foreground">{stat.label}</div>
                  </motion.div>
                )
              })}
            </div>

            {/* Summary Card */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="futuristic-card p-6 bg-gradient-to-br from-accent-cyan/5 to-accent-purple/5 border border-accent-cyan/30"
            >
              <h3 className="font-orbitron font-bold text-foreground mb-4 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-accent-cyan" />
                Résumé de l'Investissement
              </h3>
              <div className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Investissement annuel</span>
                  <span className="text-foreground font-semibold">{yearlyInvestment.toLocaleString()}€</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Économies annuelles</span>
                  <span className="text-accent-cyan font-semibold">{Math.round(yearlySavings).toLocaleString()}€</span>
                </div>
                <div className="border-t border-accent-cyan/20 pt-3 flex justify-between">
                  <span className="text-foreground font-semibold">Gain net annuel</span>
                  <span className={`font-orbitron font-bold ${netROI > 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {netROI > 0 ? '+' : ''}{Math.round(netROI).toLocaleString()}€
                  </span>
                </div>
              </div>
              
              <button
                onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
                className="w-full btn-primary mt-6"
              >
                Obtenir une Estimation Personnalisée
              </button>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}

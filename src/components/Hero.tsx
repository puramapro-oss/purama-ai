'use client'

import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Menu, X, Bot, Zap, ArrowRight, LogIn, UserPlus, Users, Star } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useInfluencer } from '@/hooks/useInfluencer'
import { Button } from '@/components/ui/button'

export function Hero() {
  const { user, loading } = useAuth()
  const { influencer } = useInfluencer()
  const [isScrolled, setIsScrolled] = useState(false)
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 50)
    }
    window.addEventListener('scroll', handleScroll)
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    if (isMobileMenuOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = 'unset'
    }
    return () => {
      document.body.style.overflow = 'unset'
    }
  }, [isMobileMenuOpen])

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background">
      {/* Animated Background */}
      <div className="absolute inset-0">
        {/* Grid pattern */}
        <div className="absolute inset-0 grid-pattern opacity-50" />
        
        {/* Gradient orbs */}
        <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-accent-purple/20 rounded-full blur-[120px] float-animation" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-accent-cyan/20 rounded-full blur-[100px] float-animation" style={{ animationDelay: '-3s' }} />
        <div className="absolute top-1/2 left-1/2 w-[400px] h-[400px] bg-accent-pink/10 rounded-full blur-[80px] float-animation" style={{ animationDelay: '-1.5s' }} />
        
        {/* Animated particles */}
        {[...Array(20)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute w-1 h-1 bg-accent-cyan rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
            }}
            animate={{
              y: [0, -30, 0],
              opacity: [0.2, 1, 0.2],
            }}
            transition={{
              duration: 3 + Math.random() * 2,
              repeat: Infinity,
              delay: Math.random() * 2,
            }}
          />
        ))}
      </div>

      {/* Navbar */}
      <motion.nav
        initial={{ opacity: 0, y: -30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, delay: 0.3 }}
        className="fixed top-0 left-0 right-0 w-full z-[110]"
      >
        <div 
          className={`w-full px-6 sm:px-8 lg:px-12 py-4 transition-all duration-300 ease-out ${
            isScrolled 
              ? 'bg-background/80 backdrop-blur-xl border-b border-accent-cyan/20' 
              : 'bg-transparent'
          }`}
        >
          <div className="flex items-center justify-between max-w-7xl mx-auto">
            {/* Logo */}
            <motion.div
              whileHover={{ scale: 1.05 }}
              className="flex items-center cursor-pointer gap-2"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            >
              <Bot className="w-8 h-8 text-accent-cyan" />
              <span className="font-orbitron text-foreground text-xl tracking-wider font-bold">
                PURAMA<span className="text-accent-cyan"> AI</span>
              </span>
            </motion.div>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center space-x-8">
              {[
                { label: 'Agents', href: '#agents-section' },
                { label: 'Fonctionnalités', href: '#features-section' },
                { label: 'Contact', href: '#contact-section' },
              ].map((item) => (
                <a 
                  key={item.label}
                  href={item.href} 
                  className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan"
                >
                  {item.label}
                </a>
              ))}
              <Link 
                to="/pricing"
                className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan"
              >
                Tarifs
              </Link>
            </div>

            {/* Auth Buttons */}
            <div className="hidden md:flex items-center gap-3">
              {!loading && !user ? (
                <>
                  <Link to="/login">
                    <Button variant="ghost" className="text-foreground/80 hover:text-accent-cyan hover:bg-accent-cyan/10">
                      <LogIn className="w-4 h-4 mr-2" />
                      Connexion
                    </Button>
                  </Link>
                  <Link to="/signup">
                    <Button className="bg-gradient-to-r from-primary to-accent hover:opacity-90">
                      <UserPlus className="w-4 h-4 mr-2" />
                      Inscription
                    </Button>
                  </Link>
                </>
              ) : !loading && user ? (
                <Link to="/dashboard">
                  <Button className="bg-gradient-to-r from-primary to-accent hover:opacity-90">
                    Mon Dashboard
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              ) : null}
            </div>

            <div className="flex items-center gap-4">

              {/* Mobile Menu Button */}
              <button
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                className="md:hidden glass-effect p-3 rounded-full text-foreground"
              >
                {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </motion.nav>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="md:hidden fixed inset-0 bg-background/80 backdrop-blur-md z-[80]"
            onClick={() => setIsMobileMenuOpen(false)}
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            className="md:hidden fixed top-0 right-0 h-full w-72 bg-card border-l border-accent-cyan/20 z-[90] p-6 pt-20"
          >
            <div className="flex flex-col space-y-4">
              {[
                { label: 'Agents', href: '#agents-section' },
                { label: 'Fonctionnalités', href: '#features-section' },
                { label: 'Contact', href: '#contact-section' },
              ].map((item) => (
                <a 
                  key={item.label}
                  href={item.href}
                  className="text-foreground hover:text-accent-cyan p-3 rounded-lg hover:bg-accent-cyan/10 transition-all font-medium"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {item.label}
                </a>
              ))}
              <Link 
                to="/pricing"
                className="text-foreground hover:text-accent-cyan p-3 rounded-lg hover:bg-accent-cyan/10 transition-all font-medium"
                onClick={() => setIsMobileMenuOpen(false)}
              >
                Tarifs
              </Link>

              {/* Influencer Links */}
              <div className="border-t border-border pt-4 mt-2">
                <Link 
                  to="/influenceur/inscription"
                  className="text-foreground hover:text-accent-cyan p-3 rounded-lg hover:bg-accent-cyan/10 transition-all font-medium flex items-center gap-2"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <Users className="w-4 h-4" />
                  Devenir Influenceur
                </Link>
                {influencer && (
                  <Link 
                    to="/influenceur/dashboard"
                    className="text-foreground hover:text-accent-cyan p-3 rounded-lg hover:bg-accent-cyan/10 transition-all font-medium flex items-center gap-2"
                    onClick={() => setIsMobileMenuOpen(false)}
                  >
                    <Star className="w-4 h-4" />
                    Espace Influenceur
                  </Link>
                )}
              </div>
              
              {/* Mobile Auth Buttons */}
              {!loading && !user ? (
                <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-border">
                  <Link to="/login" onClick={() => setIsMobileMenuOpen(false)}>
                    <Button variant="outline" className="w-full">
                      <LogIn className="w-4 h-4 mr-2" />
                      Connexion
                    </Button>
                  </Link>
                  <Link to="/signup" onClick={() => setIsMobileMenuOpen(false)}>
                    <Button className="w-full bg-gradient-to-r from-primary to-accent">
                      <UserPlus className="w-4 h-4 mr-2" />
                      Inscription
                    </Button>
                  </Link>
                </div>
              ) : !loading && user ? (
                <Link to="/dashboard" onClick={() => setIsMobileMenuOpen(false)} className="mt-4">
                  <Button className="w-full bg-gradient-to-r from-primary to-accent">
                    Mon Dashboard
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </Button>
                </Link>
              ) : null}
            </div>
          </motion.div>
        </>
      )}

      {/* Hero Content */}
      <div className="relative z-10 flex flex-col items-center justify-center min-h-screen px-6 pt-20">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.5 }}
          className="text-center max-w-5xl mx-auto"
        >
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.8 }}
            className="inline-flex items-center gap-2 glass-effect px-4 py-2 rounded-full mb-8"
          >
            <Zap className="w-4 h-4 text-accent-cyan" />
            <span className="text-sm font-medium text-foreground/80">45 Agents IA pour Automatiser Votre Business</span>
          </motion.div>

          {/* Main Title */}
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-orbitron font-black leading-tight mb-6">
            <span className="block text-foreground">AUTOMATISEZ</span>
            <span className="block gradient-text">VOTRE ENTREPRISE</span>
            <span className="block text-foreground">AVEC L'IA</span>
          </h1>

          {/* Subtitle */}
          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed">
            Découvrez nos 45 agents IA conçus pour révolutionner votre productivité. 
            Marketing, ventes, service client, RH — chaque agent est expert dans son domaine.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => document.getElementById('agents')?.scrollIntoView({ behavior: 'smooth' })}
              className="btn-primary flex items-center gap-2 text-lg px-8 py-4"
            >
              Voir les Agents
              <ArrowRight className="w-5 h-5" />
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => document.getElementById('contact')?.scrollIntoView({ behavior: 'smooth' })}
              className="btn-secondary text-lg px-8 py-4"
            >
              Nous Contacter
            </motion.button>
          </div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.2 }}
            className="grid grid-cols-3 gap-8 mt-16 max-w-2xl mx-auto"
          >
            {[
              { value: '45', label: 'Agents IA' },
              { value: '99%', label: 'Automatisation' },
              { value: '24/7', label: 'Disponibilité' },
            ].map((stat, index) => (
              <div key={index} className="text-center">
                <div className="text-3xl sm:text-4xl font-orbitron font-bold text-accent-cyan neon-text-cyan">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
              </div>
            ))}
          </motion.div>
        </motion.div>

        {/* Scroll Indicator */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 2 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2"
        >
          <motion.div
            animate={{ y: [0, 10, 0] }}
            transition={{ duration: 2, repeat: Infinity }}
            className="w-6 h-10 border-2 border-accent-cyan/50 rounded-full flex justify-center pt-2"
          >
            <div className="w-1.5 h-3 bg-accent-cyan rounded-full" />
          </motion.div>
        </motion.div>
      </div>
    </div>
  )
}

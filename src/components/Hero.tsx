'use client'

import { motion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Menu, X, Bot, Zap, ArrowRight, LogIn, UserPlus, Users, Star, Sparkles } from 'lucide-react'
import { useState, useEffect } from 'react'
import { useAuth } from '@/hooks/useAuth'
import { useInfluencer } from '@/hooks/useInfluencer'
import { Button } from '@/components/ui/button'
import heroBanner from '@/assets/hero-banner.jpg'

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
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setIsMobileMenuOpen(false)
      }
      document.addEventListener('keydown', handleEscape)
      return () => document.removeEventListener('keydown', handleEscape)
    } else {
      document.body.style.overflow = 'unset'
    }
    return () => {
      document.body.style.overflow = 'unset'
    }
  }, [isMobileMenuOpen])

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background">
      {/* Hero Background Image */}
      <div className="absolute inset-0">
        <img 
          src={heroBanner} 
          alt="" 
          className="w-full h-full object-cover opacity-40"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/60 via-background/40 to-background" />
      </div>

      {/* Floating particles */}
      <div className="absolute inset-0 overflow-hidden">
        {[...Array(12)].map((_, i) => (
          <motion.div
            key={i}
            className="absolute rounded-full"
            style={{
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              width: Math.random() * 4 + 2,
              height: Math.random() * 4 + 2,
              background: i % 3 === 0 ? 'var(--accent-cyan)' : i % 3 === 1 ? 'var(--accent-purple)' : 'var(--accent-pink)',
            }}
            animate={{
              y: [0, -40, 0],
              x: [0, Math.random() * 20 - 10, 0],
              opacity: [0.1, 0.8, 0.1],
              scale: [1, 1.5, 1],
            }}
            transition={{
              duration: 4 + Math.random() * 4,
              repeat: Infinity,
              delay: Math.random() * 3,
              ease: 'easeInOut',
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

            <div className="hidden md:flex items-center space-x-6">
              {[
                { label: 'Agents', href: '#agents-section' },
                { label: 'Contact', href: '#contact-section' },
              ].map((item) => (
                <a 
                  key={item.label}
                  href={item.href} 
                  className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan text-sm"
                >
                  {item.label}
                </a>
              ))}
              <Link 
                to="/forge"
                className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan text-sm relative"
              >
                🧠 Origin Forge
                <span className="absolute -top-2 -right-8 px-1.5 py-0.5 rounded text-[9px] font-bold bg-destructive text-destructive-foreground animate-pulse">NEW</span>
              </Link>
              {[
                { label: 'Tarifs', to: '/pricing' },
              ].map((item) => (
                <Link 
                  key={item.label}
                  to={item.to}
                  className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan text-sm"
                >
                  {item.label}
                </Link>
              ))}
              {user && (
                <Link 
                  to="/dashboard"
                  className="text-foreground/80 hover:text-accent-cyan font-medium transition-all duration-300 hover:neon-text-cyan text-sm"
                >
                  📊 Dashboard
                </Link>
              )}
            </div>

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

            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden glass-effect p-3 rounded-full text-foreground"
              aria-label={isMobileMenuOpen ? 'Fermer le menu' : 'Ouvrir le menu'}
              aria-expanded={isMobileMenuOpen}
            >
              {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
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
              {[
                { label: '🧠 Origin Forge', to: '/forge' },
                { label: 'Tarifs', to: '/pricing' },
                ...(user ? [{ label: '📊 Dashboard', to: '/dashboard' }] : []),
              ].map((item) => (
                <Link 
                  key={item.label}
                  to={item.to}
                  className="text-foreground hover:text-accent-cyan p-3 rounded-lg hover:bg-accent-cyan/10 transition-all font-medium"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}

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
            className="inline-flex items-center gap-2 glass-effect px-5 py-2.5 rounded-full mb-8"
          >
            <Sparkles className="w-4 h-4 text-accent-pink" />
            <span className="text-sm font-medium text-foreground/90">La Révolution de l'IA pour les Entreprises</span>
            <Zap className="w-4 h-4 text-accent-cyan" />
          </motion.div>

          {/* Main Title */}
          <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-orbitron font-black leading-tight mb-6">
            <motion.span 
              className="block text-foreground"
              initial={{ opacity: 0, x: -30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.6 }}
            >
              AUTOMATISEZ
            </motion.span>
            <motion.span 
              className="block gradient-text"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.8, delay: 0.8 }}
              style={{ textShadow: '0 0 40px rgba(0, 240, 255, 0.3)' }}
            >
              VOTRE ENTREPRISE
            </motion.span>
            <motion.span 
              className="block text-foreground"
              initial={{ opacity: 0, x: 30 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 1.0 }}
            >
              AVEC L'IA
            </motion.span>
          </h1>

          {/* Subtitle */}
          <motion.p 
            className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10 leading-relaxed"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 1.2 }}
          >
            45 agents IA spécialisés qui travaillent 24/7 pour vous. 
            Marketing, ventes, RH, finance — chaque département optimisé.
          </motion.p>

          {/* CTA Buttons */}
          <motion.div 
            className="flex flex-col sm:flex-row items-center justify-center gap-4"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.4 }}
          >
            <motion.button
              whileHover={{ scale: 1.05, boxShadow: '0 0 50px rgba(0, 240, 255, 0.5)' }}
              whileTap={{ scale: 0.95 }}
              onClick={() => document.getElementById('agents-section')?.scrollIntoView({ behavior: 'smooth' })}
              className="btn-primary flex items-center gap-2 text-lg px-8 py-4"
            >
              <Sparkles className="w-5 h-5" />
              Découvrir les Agents
              <ArrowRight className="w-5 h-5" />
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => document.getElementById('roi-calculator')?.scrollIntoView({ behavior: 'smooth' })}
              className="btn-secondary text-lg px-8 py-4"
            >
              Calculer mes Économies
            </motion.button>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.6 }}
            className="grid grid-cols-3 gap-8 mt-16 max-w-2xl mx-auto"
          >
            {[
              { value: '45+', label: 'Agents IA' },
              { value: '99%', label: 'Automatisation' },
              { value: '24/7', label: 'Disponibilité' },
            ].map((stat, index) => (
              <motion.div 
                key={index} 
                className="text-center"
                whileHover={{ scale: 1.1 }}
                transition={{ type: 'spring', stiffness: 300 }}
              >
                <div className="text-3xl sm:text-4xl font-orbitron font-bold text-accent-cyan neon-text-cyan">
                  {stat.value}
                </div>
                <div className="text-sm text-muted-foreground mt-1">{stat.label}</div>
              </motion.div>
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

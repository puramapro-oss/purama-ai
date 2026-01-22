'use client'

import { motion } from 'framer-motion'
import { useState } from 'react'
import { Send, Mail, MessageSquare, Phone, MapPin, ArrowRight } from 'lucide-react'
import { supabase } from '@/integrations/supabase/client'
import { useToast } from '@/hooks/use-toast'

export function Contact() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    company: '',
    message: '',
  })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    // Basic validation
    if (!formData.name.trim() || !formData.email.trim() || !formData.message.trim()) {
      toast({
        title: "Erreur",
        description: "Veuillez remplir tous les champs obligatoires.",
        variant: "destructive",
      })
      return
    }

    // Email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(formData.email)) {
      toast({
        title: "Erreur",
        description: "Veuillez entrer une adresse email valide.",
        variant: "destructive",
      })
      return
    }

    setIsSubmitting(true)
    
    try {
      const { error } = await supabase
        .from('contact_submissions')
        .insert({
          name: formData.name.trim(),
          email: formData.email.trim(),
          company: formData.company.trim() || null,
          message: formData.message.trim(),
        })

      if (error) throw error

      setSubmitted(true)
      toast({
        title: "Message envoyé !",
        description: "Nous vous répondrons dans les plus brefs délais.",
      })
    } catch (error) {
      console.error('Error submitting contact form:', error)
      toast({
        title: "Erreur",
        description: "Une erreur est survenue. Veuillez réessayer.",
        variant: "destructive",
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <section id="contact" className="relative py-24 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-card/30">
        <div className="absolute inset-0 grid-pattern opacity-20" />
        <div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] bg-accent-cyan/10 rounded-full blur-[150px]" />
        <div className="absolute top-0 right-1/4 w-[400px] h-[400px] bg-accent-purple/10 rounded-full blur-[100px]" />
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
            <MessageSquare className="w-4 h-4 text-accent-cyan" />
            <span className="text-sm font-medium text-foreground/80">Parlons de Votre Projet</span>
          </div>
          
          <h2 className="text-4xl sm:text-5xl lg:text-6xl font-orbitron font-bold mb-6">
            <span className="text-foreground">Prêt à </span>
            <span className="gradient-text">Automatiser</span>
            <span className="text-foreground"> ?</span>
          </h2>
          
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Notre équipe d'experts est là pour vous accompagner dans votre transformation digitale.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-12 max-w-6xl mx-auto">
          {/* Contact Info */}
          <motion.div
            initial={{ opacity: 0, x: -30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="space-y-8"
          >
            <div>
              <h3 className="text-2xl font-orbitron font-bold text-foreground mb-4">
                Discutons de Vos Besoins
              </h3>
              <p className="text-muted-foreground leading-relaxed">
                Que vous soyez une startup ambitieuse ou une entreprise établie, 
                nous avons la solution IA parfaite pour automatiser vos processus 
                et booster votre productivité.
              </p>
            </div>

            {/* Contact Cards */}
            <div className="space-y-4">
              {[
                { icon: Mail, label: 'Email', value: 'contact@aiagents.fr' },
                { icon: Phone, label: 'Téléphone', value: '+33 1 23 45 67 89' },
                { icon: MapPin, label: 'Adresse', value: 'Paris, France' },
              ].map((item, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="futuristic-card p-4 flex items-center gap-4"
                >
                  <div className="w-12 h-12 bg-accent-cyan/10 rounded-xl flex items-center justify-center">
                    <item.icon className="w-5 h-5 text-accent-cyan" />
                  </div>
                  <div>
                    <div className="text-sm text-muted-foreground">{item.label}</div>
                    <div className="text-foreground font-medium">{item.value}</div>
                  </div>
                </motion.div>
              ))}
            </div>

            {/* Quick Benefits */}
            <div className="futuristic-card p-6">
              <h4 className="font-orbitron font-semibold text-foreground mb-4">
                Ce Que Vous Obtenez
              </h4>
              <ul className="space-y-3">
                {[
                  'Consultation gratuite de 30 minutes',
                  'Analyse personnalisée de vos besoins',
                  'Démonstration des agents pertinents',
                  'Proposition sur mesure',
                ].map((item, index) => (
                  <li key={index} className="flex items-center gap-3 text-foreground/80">
                    <ArrowRight className="w-4 h-4 text-accent-cyan" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>

          {/* Contact Form */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
          >
            <div className="futuristic-card p-8">
              {submitted ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="text-center py-12"
                >
                  <div className="w-20 h-20 bg-accent-cyan/20 rounded-full flex items-center justify-center mx-auto mb-6">
                    <Send className="w-10 h-10 text-accent-cyan" />
                  </div>
                  <h3 className="text-2xl font-orbitron font-bold text-foreground mb-4">
                    Message Envoyé !
                  </h3>
                  <p className="text-muted-foreground mb-6">
                    Nous vous répondrons dans les 24 heures.
                  </p>
                  <button
                    onClick={() => {
                      setSubmitted(false)
                      setFormData({ name: '', email: '', company: '', message: '' })
                    }}
                    className="btn-secondary"
                  >
                    Envoyer un autre message
                  </button>
                </motion.div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-6">
                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">
                        Nom Complet *
                      </label>
                      <input
                        type="text"
                        required
                        maxLength={100}
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent-cyan transition-colors"
                        placeholder="Jean Dupont"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-foreground mb-2">
                        Email *
                      </label>
                      <input
                        type="email"
                        required
                        maxLength={255}
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent-cyan transition-colors"
                        placeholder="jean@entreprise.fr"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Entreprise
                    </label>
                    <input
                      type="text"
                      maxLength={100}
                      value={formData.company}
                      onChange={(e) => setFormData({ ...formData, company: e.target.value })}
                      className="w-full bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent-cyan transition-colors"
                      placeholder="Nom de votre entreprise"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-foreground mb-2">
                      Votre Message *
                    </label>
                    <textarea
                      required
                      rows={5}
                      maxLength={2000}
                      value={formData.message}
                      onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                      className="w-full bg-secondary/50 border border-accent-cyan/20 rounded-lg px-4 py-3 text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-accent-cyan transition-colors resize-none"
                      placeholder="Décrivez votre projet et vos besoins en automatisation..."
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full btn-primary flex items-center justify-center gap-2 py-4 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                        Envoi en cours...
                      </>
                    ) : (
                      <>
                        Envoyer le Message
                        <Send className="w-5 h-5" />
                      </>
                    )}
                  </button>
                </form>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}

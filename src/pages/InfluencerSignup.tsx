'use client'

import { motion } from 'framer-motion'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, Users, TrendingUp, Wallet, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/useAuth'
import { useInfluencer } from '@/hooks/useInfluencer'
import { useState } from 'react'
import { toast } from 'sonner'

export default function InfluencerSignup() {
  const { user, loading: authLoading } = useAuth()
  const { influencer, isLoading, registerAsInfluencer } = useInfluencer()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('Veuillez entrer votre nom')
      return
    }
    setIsSubmitting(true)
    try {
      await registerAsInfluencer.mutateAsync(name)
      navigate('/influenceur/dashboard')
    } catch (error) {
      console.error(error)
    } finally {
      setIsSubmitting(false)
    }
  }

  const benefits = [
    {
      icon: Wallet,
      title: 'Jusqu\'à 33% de commission',
      description: 'Paliers évolutifs: Bronze 9.99%, Silver 19.99%, Gold 33%'
    },
    {
      icon: TrendingUp,
      title: 'Tableau de bord',
      description: 'Suivez vos ventes et revenus en temps réel'
    },
    {
      icon: Users,
      title: 'Lien personnalisé',
      description: 'Recevez un code promo unique à partager'
    }
  ]

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-accent-cyan"></div>
      </div>
    )
  }

  // Already an influencer
  if (influencer) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-12 max-w-2xl">
          <Button variant="ghost" className="mb-8" asChild>
            <Link to="/">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Link>
          </Button>

          <Card className="glass-effect text-center">
            <CardHeader>
              <div className="mx-auto w-16 h-16 bg-accent/20 rounded-full flex items-center justify-center mb-4">
                <CheckCircle className="w-8 h-8 text-accent" />
              </div>
              <CardTitle className="text-2xl">Vous êtes déjà partenaire !</CardTitle>
              <CardDescription>
                Accédez à votre tableau de bord pour suivre vos performances.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild className="bg-gradient-to-r from-primary to-accent">
                <Link to="/influenceur/dashboard">
                  Accéder à mon espace
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Not logged in
  if (!user) {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto px-4 py-12 max-w-4xl">
          <Button variant="ghost" className="mb-8" asChild>
            <Link to="/">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Link>
          </Button>

          <div className="text-center mb-12">
            <h1 className="text-4xl font-orbitron font-bold mb-4">
              Devenez <span className="text-accent-cyan">Partenaire</span>
            </h1>
            <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
              Rejoignez notre programme d'affiliation et gagnez des commissions sur chaque vente.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            {benefits.map((benefit, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
              >
                <Card className="glass-effect h-full">
                  <CardHeader className="text-center">
                    <div className="mx-auto w-12 h-12 bg-accent-cyan/20 rounded-lg flex items-center justify-center mb-4">
                      <benefit.icon className="w-6 h-6 text-accent-cyan" />
                    </div>
                    <CardTitle className="text-lg">{benefit.title}</CardTitle>
                    <CardDescription>{benefit.description}</CardDescription>
                  </CardHeader>
                </Card>
              </motion.div>
            ))}
          </div>

          <Card className="glass-effect max-w-md mx-auto">
            <CardHeader className="text-center">
              <CardTitle>Connectez-vous pour commencer</CardTitle>
              <CardDescription>
                Vous devez être connecté pour devenir partenaire.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button asChild className="bg-gradient-to-r from-primary to-accent">
                <Link to="/signup">Créer un compte</Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/login">Se connecter</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    )
  }

  // Logged in, not an influencer - show registration form
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-12 max-w-4xl">
        <Button variant="ghost" className="mb-8" asChild>
          <Link to="/">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Retour
          </Link>
        </Button>

        <div className="text-center mb-12">
          <h1 className="text-4xl font-orbitron font-bold mb-4">
            Devenez <span className="text-accent-cyan">Partenaire</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Rejoignez notre programme d'affiliation et gagnez des commissions sur chaque vente.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-6 mb-12">
          {benefits.map((benefit, index) => (
            <motion.div
              key={index}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.1 }}
            >
              <Card className="glass-effect h-full">
                <CardHeader className="text-center">
                  <div className="mx-auto w-12 h-12 bg-accent-cyan/20 rounded-lg flex items-center justify-center mb-4">
                    <benefit.icon className="w-6 h-6 text-accent-cyan" />
                  </div>
                  <CardTitle className="text-lg">{benefit.title}</CardTitle>
                  <CardDescription>{benefit.description}</CardDescription>
                </CardHeader>
              </Card>
            </motion.div>
          ))}
        </div>

        <Card className="glass-effect max-w-md mx-auto">
          <CardHeader className="text-center">
            <CardTitle>S'inscrire comme partenaire</CardTitle>
            <CardDescription>
              Remplissez le formulaire pour recevoir votre lien d'affiliation.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Votre nom ou pseudo</Label>
                <Input
                  id="name"
                  placeholder="Ex: Jean Marketing"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>
              <Button 
                type="submit" 
                className="w-full bg-gradient-to-r from-primary to-accent"
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Inscription...' : 'Devenir Partenaire'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

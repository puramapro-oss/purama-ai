import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Check,
  Crown,
  Zap,
  ArrowLeft,
  Loader2,
  Sparkles,
  Settings,
  Gift,
  Rocket,
  Shield,
  Clock,
  Star,
  ArrowRight,
  Bot,
  TrendingUp,
  Users,
  Headphones
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useReferralTracking } from '@/hooks/useInfluencer';

const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    monthlyPrice: 66,
    yearlyPrice: 530,
    monthlyPriceId: 'price_1SsT3a4Y1unNvKtXMIU8MvN6',
    yearlyPriceId: 'price_1SsY0t4Y1unNvKtXhJN6n3Vb',
    productId: 'prod_Tq9M8BqZXnWp8A',
    yearlyProductId: 'prod_TqETIWE4cO3JqH',
    tagline: 'Lancez votre automatisation',
    subtitle: 'Parfait pour les entrepreneurs qui veulent tester la puissance de l\'IA sans se ruiner.',
    icon: Zap,
    color: 'from-blue-500 to-cyan-500',
    highlight: false,
    features: [
      { text: '5 agents IA au choix parmi 45+', bold: true },
      { text: 'Exécutions illimitées 24h/24' },
      { text: 'Support par email (< 24h)' },
      { text: 'Toutes les intégrations incluses' },
      { text: 'Dashboard complet & intuitif' },
      { text: '14 jours d\'essai gratuit' },
    ],
    results: [
      '10h gagnées / semaine en moyenne',
      '+25% de productivité dès le 1er mois',
    ],
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    monthlyPrice: 99,
    yearlyPrice: 796,
    monthlyPriceId: 'price_1SsT7x4Y1unNvKtXvRnyLp4W',
    yearlyPriceId: 'price_1SsY1T4Y1unNvKtXUP6btXHe',
    productId: 'prod_Tq9Q2m69e3A5h4',
    yearlyProductId: 'prod_TqEUl7wUEF8NEO',
    tagline: 'Automatisation totale',
    subtitle: 'Pour ceux qui veulent tout automatiser. Zéro limite, résultats maximum.',
    icon: Crown,
    color: 'from-purple-500 to-pink-500',
    highlight: true,
    features: [
      { text: 'TOUS les 45+ agents IA', bold: true },
      { text: 'Exécutions illimitées 24h/24' },
      { text: 'Support prioritaire 24/7' },
      { text: 'Toutes les intégrations incluses' },
      { text: 'Analytics avancés & rapports' },
      { text: 'Agents personnalisables' },
      { text: 'Accès API complet' },
      { text: '14 jours d\'essai gratuit' },
    ],
    results: [
      '20h+ gagnées / semaine en moyenne',
      '+47% de conversions commerciales',
      'ROI positif en moins de 7 jours',
    ],
  },
};

const testimonials = [
  { name: 'Sophie M.', role: 'E-commerce', text: 'En 2 semaines, mes ventes ont augmenté de 35%. Les agents travaillent même quand je dors.', stars: 5 },
  { name: 'Thomas R.', role: 'Agence Marketing', text: 'On a remplacé 3 outils par PURAMA AI. C\'est plus simple et 10x plus efficace.', stars: 5 },
  { name: 'Marie L.', role: 'Freelance', text: 'Le meilleur investissement de mon année. Je gère 2x plus de clients sans stress.', stars: 5 },
];

export default function Pricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>('free');
  const [subscriptionEnd, setSubscriptionEnd] = useState<string | null>(null);
  const [checkingSubscription, setCheckingSubscription] = useState(false);
  const [billingPeriod, setBillingPeriod] = useState<'monthly' | 'yearly'>('monthly');

  useEffect(() => {
    if (searchParams.get('success') === 'true') {
      toast.success('Abonnement activé !', {
        description: 'Merci pour votre confiance. Votre abonnement est maintenant actif.',
      });
      checkSubscription();
    } else if (searchParams.get('canceled') === 'true') {
      toast.info('Paiement annulé', {
        description: 'Le processus de paiement a été annulé.',
      });
    }
  }, [searchParams]);

  const checkSubscription = async () => {
    if (!user) return;
    setCheckingSubscription(true);
    try {
      const { data, error } = await supabase.functions.invoke('check-subscription');
      if (error) throw error;
      if (data) {
        setCurrentPlan(data.plan_type || 'free');
        setSubscriptionEnd(data.subscription_end);
      }
    } catch (err) {
      console.error('Error checking subscription:', err);
    } finally {
      setCheckingSubscription(false);
    }
  };

  useEffect(() => {
    checkSubscription();
  }, [user]);

  const { getStoredReferral } = useReferralTracking();

  const handleSubscribe = async (planId: string) => {
    if (!user) {
      toast.error('Connexion requise', {
        description: 'Veuillez vous connecter pour souscrire à un abonnement.',
      });
      navigate('/login');
      return;
    }

    const plan = PLANS[planId as keyof typeof PLANS];
    if (!plan) return;

    const priceId = billingPeriod === 'yearly' ? plan.yearlyPriceId : plan.monthlyPriceId;

    setLoading(planId);
    try {
      const storedReferral = getStoredReferral();
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: {
          priceId,
          referralCode: storedReferral?.code || null,
        },
      });

      if (error) throw error;

      if (data?.url) {
        if (data.hasDiscount && data.influencerName) {
          toast.success('Réduction appliquée !', {
            description: `-50% grâce à ${data.influencerName}`,
            icon: <Gift className="w-4 h-4" />,
          });
        }
        window.open(data.url, '_blank');
      }
    } catch (err) {
      console.error('Checkout error:', err);
      toast.error('Erreur', {
        description: 'Impossible de créer la session de paiement.',
      });
    } finally {
      setLoading(null);
    }
  };

  const handleManageSubscription = async () => {
    if (!user) return;
    setLoading('manage');
    try {
      const { data, error } = await supabase.functions.invoke('customer-portal');
      if (error) throw error;
      if (data?.url) {
        window.open(data.url, '_blank');
      }
    } catch (err) {
      console.error('Portal error:', err);
      toast.error('Erreur', {
        description: 'Impossible d\'ouvrir le portail de gestion.',
      });
    } finally {
      setLoading(null);
    }
  };

  const isCurrentPlan = (planId: string) => currentPlan === planId;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-background/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/">
            <Button variant="ghost">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Retour
            </Button>
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Bot className="w-6 h-6 text-accent-cyan" />
            <span className="font-orbitron font-bold text-foreground">PURAMA <span className="text-accent-cyan">AI</span></span>
          </Link>
          {user && currentPlan !== 'free' ? (
            <Button
              variant="outline"
              onClick={handleManageSubscription}
              disabled={loading === 'manage'}
            >
              {loading === 'manage' ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Settings className="w-4 h-4 mr-2" />
              )}
              Gérer mon abonnement
            </Button>
          ) : <div className="w-10" />}
        </div>
      </header>

      <main className="container mx-auto px-4 py-16 max-w-6xl">
        {/* Hero */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-16"
        >
          <motion.div
            initial={{ scale: 0.9 }}
            animate={{ scale: 1 }}
            className="inline-flex items-center gap-2 bg-accent-cyan/10 border border-accent-cyan/30 px-4 py-2 rounded-full mb-6"
          >
            <Sparkles className="w-4 h-4 text-accent-cyan" />
            <span className="text-sm font-semibold text-accent-cyan">Offre de lancement — Places limitées</span>
          </motion.div>

          <h1 className="text-4xl md:text-6xl font-orbitron font-black mb-6 leading-tight">
            <span className="text-foreground">Automatisez.</span>{' '}
            <span className="gradient-text-cyan-purple">Dominez.</span>{' '}
            <span className="text-foreground">Gagnez.</span>
          </h1>

          <p className="text-muted-foreground text-lg md:text-xl max-w-3xl mx-auto mb-4">
            Pendant que vos concurrents perdent des heures sur des tâches répétitives,
            <span className="text-foreground font-semibold"> vos agents IA travaillent 24h/24 pour vous.</span>
          </p>

          {/* Trust badges */}
          <div className="flex flex-wrap justify-center gap-6 mt-8 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <Shield className="w-4 h-4 text-accent-emerald" />
              <span>Paiement sécurisé</span>
            </div>
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-accent-cyan" />
              <span>14 jours d'essai gratuit</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-accent-purple" />
              <span>Résiliable en 1 clic</span>
            </div>
          </div>
        </motion.div>

        {/* Billing Toggle */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="flex items-center justify-center gap-4 mb-12"
        >
          <button
            onClick={() => setBillingPeriod('monthly')}
            className={`px-5 py-2.5 rounded-xl font-semibold transition-all text-sm ${
              billingPeriod === 'monthly'
                ? 'bg-accent-cyan text-background shadow-[0_0_20px_rgba(0,240,255,0.3)]'
                : 'text-muted-foreground hover:text-foreground bg-secondary/30'
            }`}
          >
            Mensuel
          </button>
          <button
            onClick={() => setBillingPeriod('yearly')}
            className={`px-5 py-2.5 rounded-xl font-semibold transition-all text-sm flex items-center gap-2 ${
              billingPeriod === 'yearly'
                ? 'bg-accent-cyan text-background shadow-[0_0_20px_rgba(0,240,255,0.3)]'
                : 'text-muted-foreground hover:text-foreground bg-secondary/30'
            }`}
          >
            Annuel
            <span className="px-2 py-0.5 rounded-full bg-accent-emerald/20 text-accent-emerald text-xs font-bold">
              -33%
            </span>
          </button>
        </motion.div>

        {/* Current subscription info */}
        {user && currentPlan !== 'free' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md mx-auto mb-12"
          >
            <div className="futuristic-card p-6 text-center border-accent-emerald/30">
              <p className="text-sm text-muted-foreground mb-2">Votre abonnement actuel</p>
              <p className="text-xl font-bold capitalize text-accent-emerald">{currentPlan}</p>
              {subscriptionEnd && (
                <p className="text-sm text-muted-foreground mt-2">
                  Renouvellement: {new Date(subscriptionEnd).toLocaleDateString('fr-FR')}
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* Pricing cards */}
        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto mb-20">
          {Object.values(PLANS).map((plan, index) => {
            const Icon = plan.icon;
            const isCurrent = isCurrentPlan(plan.id);

            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 + index * 0.15 }}
                className={`relative futuristic-card p-8 flex flex-col ${
                  plan.highlight
                    ? 'ring-2 ring-accent-purple shadow-[0_0_40px_rgba(124,58,237,0.2)] lg:scale-105'
                    : ''
                } ${isCurrent ? 'ring-2 ring-accent-emerald' : ''}`}
              >
                {/* Badge */}
                {plan.highlight && !isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-4 py-1 rounded-full text-xs font-bold bg-gradient-to-r from-accent-purple to-accent-pink text-white">
                      Le + populaire
                    </span>
                  </div>
                )}
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="px-4 py-1 rounded-full text-xs font-bold bg-accent-emerald text-white flex items-center gap-1">
                      <Check className="w-3 h-3" /> Votre plan
                    </span>
                  </div>
                )}

                {/* Header */}
                <div className="mb-6">
                  <div className={`w-14 h-14 rounded-xl bg-gradient-to-r ${plan.color} flex items-center justify-center mb-4`}>
                    <Icon className="w-7 h-7 text-white" />
                  </div>
                  <h3 className="text-2xl font-orbitron font-bold text-foreground">{plan.name}</h3>
                  <p className="text-accent-cyan font-semibold text-sm mt-1">{plan.tagline}</p>
                  <p className="text-muted-foreground text-sm mt-2">{plan.subtitle}</p>
                </div>

                {/* Price */}
                <div className="mb-6 pb-6 border-b border-border">
                  {billingPeriod === 'yearly' ? (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-5xl font-orbitron font-black text-foreground">{plan.yearlyPrice}€</span>
                        <span className="text-muted-foreground text-sm">/an</span>
                      </div>
                      <p className="text-sm mt-1">
                        <span className="line-through text-muted-foreground">{plan.monthlyPrice * 12}€</span>
                        <span className="text-accent-emerald font-semibold ml-2">Économisez {plan.monthlyPrice * 12 - plan.yearlyPrice}€</span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        soit {Math.round(plan.yearlyPrice / 12)}€/mois
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2">
                        <span className="text-5xl font-orbitron font-black text-foreground">{plan.monthlyPrice}€</span>
                        <span className="text-muted-foreground text-sm">/mois</span>
                      </div>
                      <p className="text-xs text-accent-emerald mt-1">Soit {(plan.monthlyPrice / 30).toFixed(2)}€/jour — moins qu'un café</p>
                    </>
                  )}
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-6 flex-1">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <div className="mt-0.5 w-5 h-5 rounded-full bg-accent-emerald/20 flex items-center justify-center flex-shrink-0">
                        <Check className="w-3 h-3 text-accent-emerald" />
                      </div>
                      <span className={`text-sm text-foreground/90 ${feature.bold ? 'font-bold text-accent-cyan' : ''}`}>
                        {feature.text}
                      </span>
                    </li>
                  ))}
                </ul>

                {/* Results */}
                <div className="bg-accent-cyan/5 border border-accent-cyan/20 rounded-xl p-4 mb-6">
                  <p className="text-xs font-semibold text-accent-cyan mb-2 flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" /> Résultats moyens
                  </p>
                  {plan.results.map((result, i) => (
                    <p key={i} className="text-sm text-foreground/80 flex items-center gap-2 mt-1">
                      <span className="text-accent-emerald">+</span> {result}
                    </p>
                  ))}
                </div>

                {/* CTA */}
                <Button
                  onClick={() => handleSubscribe(plan.id)}
                  disabled={loading === plan.id || isCurrent || checkingSubscription}
                  className={`w-full py-6 text-base font-bold transition-all ${
                    isCurrent
                      ? 'bg-accent-emerald/20 text-accent-emerald border border-accent-emerald/30'
                      : `bg-gradient-to-r ${plan.color} hover:opacity-90 shadow-lg hover:shadow-xl`
                  }`}
                  size="lg"
                >
                  {loading === plan.id ? (
                    <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                  ) : isCurrent ? (
                    <>
                      <Check className="w-5 h-5 mr-2" />
                      Plan actuel
                    </>
                  ) : (
                    <>
                      <Rocket className="w-5 h-5 mr-2" />
                      Commencer Maintenant
                      <ArrowRight className="w-5 h-5 ml-2" />
                    </>
                  )}
                </Button>
              </motion.div>
            );
          })}
        </div>

        {/* Social proof */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="mb-20"
        >
          <h2 className="text-2xl font-orbitron font-bold text-center mb-8 text-foreground">
            Ils ont <span className="text-accent-cyan">transformé</span> leur business
          </h2>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {testimonials.map((t, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1 }}
                className="futuristic-card p-6"
              >
                <div className="flex gap-0.5 mb-3">
                  {[...Array(t.stars)].map((_, j) => (
                    <Star key={j} className="w-4 h-4 fill-yellow-500 text-yellow-500" />
                  ))}
                </div>
                <p className="text-sm text-foreground/80 mb-4 italic">"{t.text}"</p>
                <div>
                  <p className="text-sm font-semibold text-foreground">{t.name}</p>
                  <p className="text-xs text-muted-foreground">{t.role}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        {/* Guarantees */}
        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          className="text-center max-w-3xl mx-auto mb-12"
        >
          <div className="futuristic-card p-8">
            <Shield className="w-12 h-12 text-accent-emerald mx-auto mb-4" />
            <h3 className="text-xl font-orbitron font-bold text-foreground mb-3">Garantie 100% sans risque</h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              14 jours d'essai gratuit. Pas de carte bancaire requise pour tester.
              Si vous n'êtes pas 100% satisfait, annulez en 1 clic. Aucun engagement, aucune surprise.
              Nous sommes tellement sûrs de notre produit que nous prenons le risque à votre place.
            </p>
          </div>
        </motion.div>

        {/* Bottom CTA */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="text-center text-muted-foreground text-sm"
        >
          <p>
            Des questions ?{' '}
            <Link to="/#contact-section" className="text-accent-cyan hover:underline">
              Contactez-nous
            </Link>
            {' '}— Nous répondons en moins de 2h.
          </p>
        </motion.div>
      </main>
    </div>
  );
}

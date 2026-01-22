import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Check, 
  Crown, 
  Zap, 
  Building2, 
  ArrowLeft, 
  Loader2,
  Sparkles,
  Settings
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Stripe price and product IDs
const PLANS = {
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 19,
    priceId: 'price_1SsT3a4Y1unNvKtXMIU8MvN6',
    productId: 'prod_Tq9M8BqZXnWp8A',
    description: 'Idéal pour démarrer',
    icon: Zap,
    color: 'from-blue-500 to-cyan-500',
    features: [
      '5 agents IA basiques',
      '100 exécutions/mois',
      'Support par email',
      'Intégrations essentielles',
      'Tableau de bord basique',
    ],
  },
  premium: {
    id: 'premium',
    name: 'Premium',
    price: 49,
    priceId: 'price_1SsT7x4Y1unNvKtXvRnyLp4W',
    productId: 'prod_Tq9Q2m69e3A5h4',
    description: 'Pour les professionnels',
    icon: Crown,
    color: 'from-purple-500 to-pink-500',
    popular: true,
    features: [
      'Tous les agents IA (45+)',
      'Exécutions illimitées',
      'Support prioritaire 24/7',
      'Toutes les intégrations',
      'Analytics avancés',
      'Agents personnalisables',
      'API access',
    ],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    price: 99,
    priceId: 'price_1SsT8L4Y1unNvKtXSeH1ZZBV',
    productId: 'prod_Tq9R8iVUYzD0UE',
    description: 'Solution sur mesure',
    icon: Building2,
    color: 'from-amber-500 to-orange-500',
    features: [
      'Tout Premium +',
      'Agents sur mesure',
      'API dédiée',
      'Support 24/7 dédié',
      'Formation équipe',
      'SLA garanti',
      'Facturation personnalisée',
      'Déploiement on-premise',
    ],
  },
};

export default function Pricing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);
  const [currentPlan, setCurrentPlan] = useState<string>('free');
  const [subscriptionEnd, setSubscriptionEnd] = useState<string | null>(null);
  const [checkingSubscription, setCheckingSubscription] = useState(false);

  // Check for success/cancel from Stripe
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

  // Check subscription status
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

    setLoading(planId);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { priceId: plan.priceId },
      });

      if (error) throw error;

      if (data?.url) {
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
          {user && currentPlan !== 'free' && (
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
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-16">
        {/* Hero section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-16"
        >
          <Badge className="mb-4 bg-primary/20 text-primary border-primary/30">
            <Sparkles className="w-3 h-3 mr-1" />
            Offres spéciales
          </Badge>
          <h1 className="text-4xl md:text-5xl font-bold mb-4">
            Choisissez votre{' '}
            <span className="gradient-text-cyan-purple">plan</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-2xl mx-auto">
            Débloquez le potentiel de l'IA pour automatiser votre business.
            Tous les plans incluent un essai gratuit de 7 jours.
          </p>
        </motion.div>

        {/* Current subscription info */}
        {user && currentPlan !== 'free' && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md mx-auto mb-12"
          >
            <div className="futuristic-card p-6 text-center">
              <p className="text-sm text-muted-foreground mb-2">Votre abonnement actuel</p>
              <p className="text-xl font-bold capitalize">{currentPlan}</p>
              {subscriptionEnd && (
                <p className="text-sm text-muted-foreground mt-2">
                  Renouvellement: {new Date(subscriptionEnd).toLocaleDateString('fr-FR')}
                </p>
              )}
            </div>
          </motion.div>
        )}

        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-8 max-w-6xl mx-auto">
          {Object.values(PLANS).map((plan, index) => {
            const Icon = plan.icon;
            const isCurrent = isCurrentPlan(plan.id);
            const isPopular = 'popular' in plan && plan.popular;
            
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.1 }}
                className={`relative futuristic-card p-8 ${
                  isPopular ? 'ring-2 ring-primary' : ''
                } ${isCurrent ? 'ring-2 ring-green-500' : ''}`}
              >
                {/* Popular badge */}
                {isPopular && !isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-primary to-accent text-white border-0">
                      Plus populaire
                    </Badge>
                  </div>
                )}

                {/* Current plan badge */}
                {isCurrent && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-green-500 text-white border-0">
                      <Check className="w-3 h-3 mr-1" />
                      Votre plan
                    </Badge>
                  </div>
                )}

                {/* Icon */}
                <div
                  className={`w-14 h-14 rounded-xl bg-gradient-to-r ${plan.color} flex items-center justify-center mb-6`}
                >
                  <Icon className="w-7 h-7 text-white" />
                </div>

                {/* Plan info */}
                <h3 className="text-2xl font-bold mb-2">{plan.name}</h3>
                <p className="text-muted-foreground mb-4">{plan.description}</p>

                {/* Price */}
                <div className="mb-6">
                  <span className="text-4xl font-bold">{plan.price}€</span>
                  <span className="text-muted-foreground">/mois</span>
                </div>

                {/* Features */}
                <ul className="space-y-3 mb-8">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <Check className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
                      <span className="text-sm">{feature}</span>
                    </li>
                  ))}
                </ul>

                {/* CTA button */}
                <Button
                  onClick={() => handleSubscribe(plan.id)}
                  disabled={loading === plan.id || isCurrent || checkingSubscription}
                  className={`w-full ${
                    isCurrent
                      ? 'bg-green-500/20 text-green-500 border border-green-500/30'
                      : `bg-gradient-to-r ${plan.color}`
                  }`}
                  size="lg"
                >
                  {loading === plan.id ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : isCurrent ? (
                    <>
                      <Check className="w-4 h-4 mr-2" />
                      Plan actuel
                    </>
                  ) : (
                    <>
                      <Zap className="w-4 h-4 mr-2" />
                      Commencer
                    </>
                  )}
                </Button>
              </motion.div>
            );
          })}
        </div>

        {/* Free plan notice */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="text-center mt-12 text-muted-foreground"
        >
          <p>
            Vous utilisez actuellement le plan gratuit ?{' '}
            <span className="text-foreground">3 agents disponibles, 10 exécutions/mois</span>
          </p>
        </motion.div>
      </main>
    </div>
  );
}

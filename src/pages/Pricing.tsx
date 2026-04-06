import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Check, Crown, Zap, ArrowLeft, Loader2, Sparkles, Gift, Rocket,
  Star, Bot, Calculator,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { PLAN_LIST, type Plan } from '@/lib/plans';

const ICONS: Record<string, typeof Zap> = {
  free: Gift,
  starter: Zap,
  pro: Rocket,
  ultime: Crown,
};

const COLORS: Record<string, string> = {
  free: 'from-slate-500 to-slate-600',
  starter: 'from-blue-500 to-cyan-500',
  pro: 'from-purple-500 to-pink-500',
  ultime: 'from-amber-500 to-orange-500',
};

export default function Pricing() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly');
  const [loadingPlan, setLoadingPlan] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const nav = useNavigate();

  const success = searchParams.get('success');
  const canceled = searchParams.get('canceled');

  const handleCheckout = async (plan: Plan) => {
    if (!user) {
      nav(`/login?next=${encodeURIComponent('/pricing')}`);
      return;
    }
    if (plan.id === 'free') {
      toast.success('Tu es déjà sur le plan Free 🎉');
      return;
    }
    const priceId = billingCycle === 'monthly' ? plan.monthly_price_id : plan.yearly_price_id;
    if (!priceId) {
      toast.error('Plan indisponible');
      return;
    }
    setLoadingPlan(plan.id);
    try {
      const { data, error } = await supabase.functions.invoke('create-checkout', {
        body: { priceId },
      });
      if (error) throw error;
      const url = (data as { url?: string } | null)?.url;
      if (!url) throw new Error('Aucune URL de checkout');
      window.location.href = url;
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
      setLoadingPlan(null);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="border-b border-border">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="w-4 h-4" /> Retour
          </Link>
          <Link to="/" className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-accent-cyan" />
            <span className="font-orbitron font-bold">PURAMA <span className="text-accent-cyan">AI</span></span>
          </Link>
          <div className="w-16" />
        </div>
      </div>

      {(success || canceled) && (
        <div className={`max-w-3xl mx-auto mt-4 px-4 py-3 rounded-lg text-sm ${
          success ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-300' : 'bg-yellow-500/10 border border-yellow-500/30 text-yellow-300'
        }`}>
          {success ? '✅ Paiement validé. Bienvenue sur Purama AI !' : '⚠️ Paiement annulé. Tu peux réessayer quand tu veux.'}
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 py-12">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="text-center mb-10">
          <Badge className="mb-4 bg-accent-purple/15 text-accent-purple border-accent-purple/30">
            <Sparkles className="w-3 h-3 mr-1" /> 5 agents IA · Compta inclus dans tous les plans
          </Badge>
          <h1 className="text-3xl sm:text-5xl font-orbitron font-bold mb-3">
            Un prix, <span className="text-accent-cyan">tout l'écosystème</span>
          </h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Email · Compta · Partenariat · Juridique · Créateur d'agents.
            14 jours gratuits sur tous les plans payants. Sans engagement.
          </p>
        </motion.div>

        <div className="flex items-center justify-center gap-3 mb-12">
          <button
            onClick={() => setBillingCycle('monthly')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              billingCycle === 'monthly' ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30' : 'text-muted-foreground'
            }`}
          >
            Mensuel
          </button>
          <button
            onClick={() => setBillingCycle('yearly')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
              billingCycle === 'yearly' ? 'bg-accent-cyan/15 text-accent-cyan border border-accent-cyan/30' : 'text-muted-foreground'
            }`}
          >
            Annuel
            <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">−33%</Badge>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {PLAN_LIST.map((plan, i) => {
            const Icon = ICONS[plan.id];
            const color = COLORS[plan.id];
            const price = billingCycle === 'monthly' ? plan.monthly_price : plan.yearly_price_per_month;
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
                className={`relative rounded-2xl p-6 border ${
                  plan.highlight
                    ? 'bg-gradient-to-br from-accent-purple/10 via-card to-accent-cyan/5 border-accent-purple/40 shadow-[0_20px_60px_rgba(139,92,246,0.2)]'
                    : 'bg-card border-border'
                }`}
              >
                {plan.highlight && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-accent-purple text-white border-accent-purple shadow-lg">
                      <Star className="w-3 h-3 mr-1" /> Populaire
                    </Badge>
                  </div>
                )}

                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${color} flex items-center justify-center mb-4 shadow-lg`}>
                  <Icon className="w-6 h-6 text-white" />
                </div>

                <h3 className="text-xl font-orbitron font-bold text-foreground">{plan.name}</h3>
                <p className="text-[11px] text-muted-foreground mt-1 mb-4">{plan.tagline}</p>

                <div className="mb-5">
                  {plan.id === 'free' ? (
                    <div>
                      <span className="text-4xl font-orbitron font-bold text-foreground">0€</span>
                      <span className="text-xs text-muted-foreground block mt-1">à vie</span>
                    </div>
                  ) : (
                    <div>
                      <span className="text-4xl font-orbitron font-bold text-foreground">
                        {Number.isInteger(price) ? price : price.toFixed(2)}€
                      </span>
                      <span className="text-xs text-muted-foreground"> /mois</span>
                      {billingCycle === 'yearly' && (
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {plan.yearly_total.toFixed(2)}€ facturés à l'année
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <Button
                  onClick={() => handleCheckout(plan)}
                  disabled={loadingPlan === plan.id}
                  className={`w-full mb-5 ${
                    plan.highlight ? 'bg-accent-purple hover:bg-accent-purple/90' : ''
                  }`}
                  variant={plan.id === 'free' ? 'outline' : 'default'}
                >
                  {loadingPlan === plan.id && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {plan.id === 'free' ? 'Commencer gratuitement' : 'Essai 14 jours offerts'}
                </Button>

                <ul className="space-y-2">
                  {plan.features.map((f, j) => (
                    <li key={j} className="flex items-start gap-2 text-xs text-foreground/85">
                      <Check className={`w-3.5 h-3.5 flex-shrink-0 mt-0.5 ${plan.highlight ? 'text-accent-purple' : 'text-emerald-400'}`} />
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            );
          })}
        </div>

        <div className="mt-10 rounded-2xl bg-gradient-to-r from-emerald-500/10 to-cyan-500/10 border border-emerald-500/30 p-5 flex items-center gap-4">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center flex-shrink-0">
            <Calculator className="w-6 h-6 text-emerald-400" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-foreground">Le module Compta est inclus dans <strong>tous les plans</strong>, même Free</p>
            <p className="text-xs text-muted-foreground mt-1">
              Synchronisation Bridge bancaire, catégorisation IA des transactions, déclarations TVA/IS auto, factures Factur-X. Aucun comptable nécessaire.
            </p>
          </div>
        </div>

        <div className="mt-12 text-center">
          <p className="text-xs text-muted-foreground">
            14 jours d'essai gratuit · Annulation en 1 clic · Paiement sécurisé Stripe ·{' '}
            <Link to="/pricing#faq" className="text-accent-cyan hover:underline">FAQ</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, ExternalLink, Crown, Receipt, Zap } from 'lucide-react';
import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useSubscription } from '@/hooks/useSubscription';
import { useAgents } from '@/hooks/useAgents';
import { useAgentSelections } from '@/hooks/useAgentSelections';
import { useAgentStats } from '@/hooks/useAgentStats';
import { getUsageSnapshot, formatExecutions } from '@/lib/usage';
import { OVERAGE_PACK } from '@/lib/plans';
import { isSuperAdmin } from '@/lib/constants';
import { supabase } from '@/integrations/supabase/client';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** Ouvre une session Stripe (portail client ou checkout) renvoyée par une edge function, ou affiche l'erreur FR. */
async function redirectToStripe(
  invoke: () => ReturnType<typeof supabase.functions.invoke>,
  setLoading: (b: boolean) => void,
  errorTitle: string,
  notFoundMessage: string,
) {
  setLoading(true);
  try {
    const { data, error } = await invoke();
    if (error) throw error;
    if (data?.url) {
      window.location.href = data.url;
    } else {
      throw new Error(notFoundMessage);
    }
  } catch (err) {
    console.error(err);
    toast.error(errorTitle, { description: err instanceof Error ? err.message : undefined });
  } finally {
    setLoading(false);
  }
}

export default function DashboardBilling() {
  const { user } = useAuth();
  const { planId, plan, subscriptionEnd, isTrialing, trialEndsAt, isLoading: subLoading, isPro } =
    useSubscription();
  const { data: agents = [] } = useAgents();
  const { selectedAgentIds } = useAgentSelections();
  const { raw, statsByAgent } = useAgentStats();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const { data: usage } = useQuery({
    queryKey: ['usage-snapshot', user?.id],
    enabled: !!user,
    queryFn: () => getUsageSnapshot(user!.id, user!.email),
    refetchInterval: 60_000,
  });

  const [portalLoading, setPortalLoading] = useState(false);
  const [overageLoading, setOverageLoading] = useState(false);

  const planLabel = plan.name.toUpperCase();
  const planPrice = `${plan.monthly_price}€`;
  const agentCap = plan.agents_included === -1 ? agents.length : plan.agents_included;
  const usedAgents = selectedAgentIds.length;

  // Cf ERRORS.md 2026-07-27 : redirection Stripe success/cancel du pack de dépassement
  // (create-checkout mode "payment" → stripe-webhook crédite overage_credits).
  useEffect(() => {
    if (searchParams.get('overage_success') === 'true') {
      toast.success('Pack de dépassement activé', {
        description: `+${OVERAGE_PACK.actions.toLocaleString('fr-FR')} actions ajoutées à ton quota de ce mois.`,
      });
      queryClient.invalidateQueries({ queryKey: ['usage-snapshot', user?.id] });
      searchParams.delete('overage_success');
      setSearchParams(searchParams, { replace: true });
    } else if (searchParams.get('overage_canceled') === 'true') {
      toast.info('Achat annulé', { description: 'Aucun montant débité.' });
      searchParams.delete('overage_canceled');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams, queryClient, user?.id]);

  const openCustomerPortal = () =>
    redirectToStripe(
      () => supabase.functions.invoke('customer-portal'),
      setPortalLoading,
      "Impossible d'ouvrir le portail de facturation",
      'URL du portail introuvable',
    );

  const buyOveragePack = () =>
    redirectToStripe(
      () => supabase.functions.invoke('create-checkout', { body: { priceId: OVERAGE_PACK.price_id } }),
      setOverageLoading,
      "Impossible de lancer l'achat du pack",
      'URL de paiement introuvable',
    );

  // Recent usage history (top 20)
  const history = raw.slice(0, 20);
  const usagePercent = usage?.percent ?? 0;
  const isUnlimited = isSuperAdmin(user?.email);
  const showOverageCta = !isUnlimited && planId !== 'free' && usagePercent >= 80;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-orbitron font-bold text-foreground">Abonnement & Utilisation</h1>

      {/* Current Plan */}
      <Card
        className="bg-card border-accent-purple/30"
        style={{ boxShadow: '0 0 20px rgba(124,58,237,0.15)' }}
      >
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
            <div>
              <span className="px-3 py-1 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground text-xs font-bold flex items-center gap-1 w-fit">
                {(isPro || planId === 'ultime') && <Crown className="w-3 h-3" />} {planLabel}
                {isTrialing && <span className="opacity-80">· ESSAI</span>}
              </span>
              <h2 className="text-3xl font-orbitron font-bold text-foreground mt-3">
                {subLoading ? (
                  <Loader2 className="w-7 h-7 animate-spin" />
                ) : (
                  <>
                    {planPrice}
                    <span className="text-lg text-muted-foreground">/mois</span>
                  </>
                )}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {isTrialing && trialEndsAt
                  ? `Essai gratuit jusqu'au ${formatDate(trialEndsAt)} — aucune carte enregistrée`
                  : subscriptionEnd
                    ? `Renouvellement le ${formatDate(subscriptionEnd)}`
                    : planId === 'free'
                      ? 'Aucun abonnement actif'
                      : 'Date de renouvellement indisponible'}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Link to="/pricing" className="btn-secondary text-sm px-4 py-2 text-center">
                Changer de plan →
              </Link>
              {planId !== 'free' && (
                <button
                  onClick={openCustomerPortal}
                  disabled={portalLoading}
                  className="btn-secondary text-xs px-4 py-2 flex items-center justify-center gap-1.5 disabled:opacity-60"
                >
                  {portalLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <ExternalLink className="w-3 h-3" />
                  )}
                  Portail Stripe
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6">
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Agents ({usedAgents}/{agentCap || '—'})
              </p>
              <Progress
                value={agentCap > 0 ? (usedAgents / agentCap) * 100 : 0}
                className="h-2"
              />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">
                Actions ce mois ({formatExecutions(usage?.used ?? 0)}{isUnlimited ? '' : ` / ${formatExecutions(usage?.limit ?? plan.monthly_executions)}`})
              </p>
              <Progress value={usagePercent} className="h-2" />
            </div>
          </div>

          {showOverageCta && (
            <div className="mt-6 pt-6 border-t border-border flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground flex items-center gap-1.5">
                  <Zap className="w-4 h-4 text-accent-cyan" /> Quota bientôt atteint
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  +{OVERAGE_PACK.actions.toLocaleString('fr-FR')} actions supplémentaires ce mois pour {OVERAGE_PACK.price}€, sans changer de plan.
                </p>
              </div>
              <button
                onClick={buyOveragePack}
                disabled={overageLoading}
                className="btn-secondary text-xs px-4 py-2 flex items-center justify-center gap-1.5 disabled:opacity-60 whitespace-nowrap"
              >
                {overageLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                Acheter +{OVERAGE_PACK.actions.toLocaleString('fr-FR')} actions
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Usage History */}
      <div>
        <h3 className="font-orbitron font-bold text-foreground mb-4 flex items-center gap-2">
          <Receipt className="w-4 h-4" />
          Historique des exécutions
        </h3>
        <Card className="bg-card border-border">
          <CardContent className="p-0">
            {history.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                Aucune exécution enregistrée pour le moment.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-3 px-4 text-muted-foreground font-medium">
                        Date
                      </th>
                      <th className="text-left py-3 px-4 text-muted-foreground font-medium">
                        Agent
                      </th>
                      <th className="text-left py-3 px-4 text-muted-foreground font-medium">
                        Action
                      </th>
                      <th className="text-center py-3 px-4 text-muted-foreground font-medium">
                        Statut
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => {
                      const agent = agents.find((a) => a.id === row.agent_id);
                      return (
                        <tr key={row.id} className="border-b border-border/30">
                          <td className="py-3 px-4 text-foreground/70">
                            {formatDateTime(row.created_at)}
                          </td>
                          <td className="py-3 px-4 text-foreground/80">
                            {agent?.name ?? 'Agent inconnu'}
                          </td>
                          <td className="py-3 px-4 text-foreground/70 capitalize">
                            {row.action_type}
                          </td>
                          <td className="text-center py-3 px-4">
                            <span
                              className={`text-xs font-medium ${
                                row.status === 'completed'
                                  ? 'text-accent-emerald'
                                  : row.status === 'pending'
                                    ? 'text-yellow-500'
                                    : 'text-destructive'
                              }`}
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per-agent breakdown */}
      {selectedAgentIds.length > 0 && (
        <div>
          <h3 className="font-orbitron font-bold text-foreground mb-4">
            Utilisation par agent (ce mois)
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {selectedAgentIds.map((id, i) => {
              const agent = agents.find((a) => a.id === id);
              const stat = statsByAgent.get(id);
              if (!agent) return null;
              return (
                <motion.div
                  key={id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(i * 0.05, 0.4) }}
                >
                  <Card className="bg-card border-border">
                    <CardContent className="p-5 text-center">
                      <div className="text-2xl mb-1">{agent.icon || '🤖'}</div>
                      <p className="text-xs text-foreground font-semibold truncate">
                        {agent.name}
                      </p>
                      <p className="text-2xl font-orbitron font-bold text-accent-cyan mt-2">
                        {stat?.thisMonth ?? 0}
                      </p>
                      <p className="text-xs text-muted-foreground">exécutions</p>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

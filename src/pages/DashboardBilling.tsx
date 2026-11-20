import { motion } from 'framer-motion';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Link, useSearchParams } from 'react-router-dom';
import { Loader2, ExternalLink, Crown, Receipt, Zap } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef } from 'react';
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
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { createRequestDeadline, RequestDeadlineError } from '@/lib/request-deadline';

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

export default function DashboardBilling() {
  const { user } = useAuth();
  const { planId, plan, subscriptionEnd, isTrialing, trialEndsAt, isLoading: subLoading, isError: subError, isPro, refresh: refreshSubscription } =
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

  const accountKey = user?.id ?? 'signed-out';
  const captureScope = useRequestScope(accountKey);
  const [loadingAction, setLoadingAction] = useScopedState<'portal' | 'overage' | null>(accountKey, null);
  const pending = useRef<{ current: () => boolean; deadline: ReturnType<typeof createRequestDeadline> } | null>(null);
  const overageIntent = useRef<{ userId: string; requestId: string } | null>(null);
  useLayoutEffect(() => {
    overageIntent.current = null;
    setLoadingAction(null);
    return () => {
      const request = pending.current;
      pending.current = null;
      request?.deadline.close();
    };
  }, [accountKey, setLoadingAction]);
  const portalLoading = loadingAction === 'portal';
  const overageLoading = loadingAction === 'overage';
  const billingDisabled = loadingAction !== null || !user || subLoading || subError;

  const planLabel = subError ? 'ABONNEMENT INDISPONIBLE' : plan.name.toUpperCase();
  const planPrice = `${plan.monthly_price}€`;
  const agentCap = plan.agents_included === -1 ? agents.length : plan.agents_included;
  const usedAgents = selectedAgentIds.length;

  // A checkout return is not proof of payment. Only confirmed credits in the
  // refreshed usage snapshot can change the displayed quota.
  useEffect(() => {
    const returnedFromCheckout = searchParams.get('overage_success') === 'true';
    const canceledCheckout = searchParams.get('overage_canceled') === 'true';
    if (!returnedFromCheckout && !canceledCheckout) return;
    overageIntent.current = null;

    toast.info('Retour du paiement', {
      description: returnedFromCheckout
        ? 'Le pack apparaîtra dans ton quota une fois le paiement confirmé.'
        : 'Consulte le portail de facturation pour vérifier l’état du paiement.',
    });
    if (user?.id) {
      queryClient.invalidateQueries({ queryKey: ['usage-snapshot', user?.id] });
    }
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('overage_success');
    nextSearchParams.delete('overage_canceled');
    setSearchParams(nextSearchParams, { replace: true });
  }, [searchParams, setSearchParams, queryClient, user?.id]);

  const redirectToStripe = async (action: 'portal' | 'overage') => {
    // A ref closes the gap before React commits the disabled button.
    if (!user || subLoading || subError || pending.current?.current()) return;
    const current = captureScope();
    if (!current()) return;
    const deadline = createRequestDeadline(20_000);
    const request = { current, deadline };
    pending.current = request;
    setLoadingAction(action);
    try {
      let body: { priceId: string; requestId: string } | undefined;
      if (action === 'overage') {
        if (overageIntent.current?.userId !== user.id) {
          overageIntent.current = { userId: user.id, requestId: crypto.randomUUID() };
        }
        body = { priceId: OVERAGE_PACK.price_id, requestId: overageIntent.current.requestId };
      }
      const { data, error } = await deadline.wait(() => supabase.functions.invoke(
        action === 'portal' ? 'customer-portal' : 'create-checkout', body ? { body } : undefined,
      ));
      if (!current()) return;
      if (error) throw error;
      const url: unknown = (data as { url?: unknown } | null)?.url;
      if (typeof url !== 'string' || !url.trim()) throw new Error('URL de facturation introuvable');
      const redirect = new URL(url);
      const hostname = action === 'portal' ? 'billing.stripe.com' : 'checkout.stripe.com';
      if (redirect.protocol !== 'https:' || redirect.hostname !== hostname || redirect.port || redirect.username || redirect.password) {
        throw new Error('URL de facturation non sécurisée');
      }
      deadline.check();
      if (current()) window.location.assign(redirect.href);
    } catch (error) {
      if (!current()) return;
      toast.error(action === 'portal' ? "Impossible d'ouvrir le portail de facturation" : "Impossible de lancer l'achat du pack", {
        description: error instanceof RequestDeadlineError
          ? 'La facturation met trop de temps à répondre. Réessaie dans un instant.'
          : error instanceof Error ? error.message : 'Réessaie dans un instant.',
      });
    } finally {
      deadline.close();
      if (pending.current === request) pending.current = null;
      if (current()) setLoadingAction(null);
    }
  };
  const openCustomerPortal = () => redirectToStripe('portal');
  const buyOveragePack = () => redirectToStripe('overage');

  // Recent usage history (top 20)
  const history = raw.slice(0, 20);
  const usagePercent = usage?.percent ?? 0;
  const isUnlimited = isSuperAdmin(user?.email);
  const showOverageCta = !isUnlimited && planId !== 'free' && usagePercent >= 80;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-orbitron font-bold text-foreground">Abonnement & Utilisation</h1>
      {subError && (
        <div role="alert" className="rounded-lg border border-destructive/30 p-4 text-sm">
          <p>Impossible de vérifier ton abonnement. Réessaie avant de lancer une opération de facturation.</p>
          <button onClick={refreshSubscription} disabled={subLoading} className="btn-secondary mt-3 px-3 py-2 disabled:opacity-60">
            Réessayer
          </button>
        </div>
      )}

      {/* Current Plan */}
      <Card
        className="bg-card border-accent-purple/30"
        style={{ boxShadow: '0 0 20px rgba(124,58,237,0.15)' }}
      >
        <CardContent className="p-6">
          <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
            <div>
              <span className="px-3 py-1 rounded-full bg-gradient-to-r from-accent-cyan to-accent-purple text-primary-foreground text-xs font-bold flex items-center gap-1 w-fit">
                {!subError && (isPro || planId === 'ultime') && <Crown className="w-3 h-3" />} {planLabel}
                {!subError && isTrialing && <span className="opacity-80">· ESSAI</span>}
              </span>
              <h2 className="text-3xl font-orbitron font-bold text-foreground mt-3">
                {subError ? (
                  <span className="text-base">Tarif indisponible</span>
                ) : subLoading ? (
                  <Loader2 className="w-7 h-7 animate-spin" />
                ) : (
                  <>
                    {planPrice}
                    <span className="text-lg text-muted-foreground">/mois</span>
                  </>
                )}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {subError
                  ? 'État de l’abonnement indisponible'
                  : isTrialing && trialEndsAt
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
                  disabled={billingDisabled}
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
                disabled={billingDisabled}
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

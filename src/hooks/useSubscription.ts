import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { isSuperAdmin } from '@/lib/constants';
import { getPlan, type Plan, type PlanId } from '@/lib/plans';

export interface SubscriptionInfo {
  planId: PlanId;
  subscriptionEnd: string | null;
  isTrialing: boolean;
  trialEndsAt: string | null;
  hasUsedTrial: boolean;
  isLoading: boolean;
}

interface SubscriptionRow {
  plan_type: string;
  status: string;
  trial_ends_at: string | null;
  has_used_trial: boolean;
}

/**
 * Lit purama_ai.subscriptions directement (écrite par stripe-webhook ou start_trial()) plutôt que
 * de dépendre de l'edge function check-subscription (appel Stripe live) — cf ERRORS.md 2026-07-27 :
 * check-subscription ne répond jamais en prod (pare-feu VPS bloque toute sortie Internet externe),
 * ce qui rendait les 5 pages consommant ce hook indisponibles. La table DB reste la source de
 * vérité même quand Stripe est injoignable.
 */
export function useSubscription() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['subscription', user?.id],
    enabled: !!user,
    queryFn: async (): Promise<SubscriptionRow | null> => {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', user!.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;

      // The checked-in generated types predate the trial columns added by the
      // migration. Keep the cast at this database boundary until types are
      // regenerated from the deployed schema.
      const row = data as unknown as Partial<SubscriptionRow>;
      return {
        plan_type: typeof row.plan_type === 'string' ? row.plan_type : 'free',
        status: typeof row.status === 'string' ? row.status : 'inactive',
        trial_ends_at: typeof row.trial_ends_at === 'string' ? row.trial_ends_at : null,
        has_used_trial: row.has_used_trial === true,
      };
    },
  });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['subscription', user?.id] });
  }, [queryClient, user?.id]);

  if (user && isSuperAdmin(user.email)) {
    return {
      planId: 'ultime' as PlanId,
      subscriptionEnd: null,
      isTrialing: false,
      trialEndsAt: null,
      hasUsedTrial: true,
      isLoading: false,
      plan: getPlan('ultime'),
      refresh,
      hasSubscription: true,
      isStarter: false,
      isPro: false,
      isUltime: true,
    };
  }

  const row = query.data;
  const isTrialing = row?.status === 'trialing' && !!row.trial_ends_at && new Date(row.trial_ends_at) > new Date();
  const isActive = row?.status === 'active';
  const planId: PlanId = row?.plan_type && (isActive || isTrialing) ? (row.plan_type as PlanId) : 'free';

  return {
    planId,
    // Pas de date de renouvellement Stripe fiable stockée en DB pour un abonnement payé actif
    // (nécessiterait un vrai appel Stripe, actuellement bloqué — cf ERRORS.md 2026-07-27).
    subscriptionEnd: null,
    isTrialing,
    trialEndsAt: isTrialing ? row!.trial_ends_at : null,
    hasUsedTrial: row?.has_used_trial ?? false,
    isLoading: query.isLoading,
    plan: getPlan(planId),
    refresh,
    hasSubscription: planId !== 'free',
    isStarter: planId === 'starter',
    isPro: planId === 'pro',
    isUltime: planId === 'ultime',
  };
}

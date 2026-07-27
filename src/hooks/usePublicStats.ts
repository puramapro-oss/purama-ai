import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Compteur public "X actions exécutées par nos employés IA cette semaine" (brief PRICING & OFFRE
 * IRRÉSISTIBLE) — agrégat réel via RPC SECURITY DEFINER (purama_ai.public_weekly_actions_count),
 * karta_runs restant protégé par RLS pour les visiteurs anonymes. 0 si 0 (jamais de faux chiffre). */
export function useWeeklyActionsCount() {
  return useQuery({
    queryKey: ['public-weekly-actions-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('public_weekly_actions_count');
      if (error) throw error;
      return Number(data ?? 0);
    },
    staleTime: 5 * 60_000,
  });
}

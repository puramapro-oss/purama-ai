import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

export function usePoints() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['points', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('purama_points')
        .select('*')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function usePointTransactions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['point-transactions', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('point_transactions')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function useShopItems() {
  return useQuery({
    queryKey: ['shop-items'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('point_shop_items')
        .select('*')
        .eq('is_active', true)
        .order('cost_points', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });
}

export function usePurchaseItem() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ itemId, pointsCost }: { itemId: string; pointsCost: number }) => {
      if (!user) throw new Error('Non connecté');

      const { error } = await supabase
        .from('point_purchases')
        .insert({
          user_id: user.id,
          item_id: itemId,
          points_spent: pointsCost,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['points'] });
      queryClient.invalidateQueries({ queryKey: ['point-transactions'] });
      toast.success('Achat effectué !');
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Erreur lors de l\'achat');
    },
  });
}

export function usePointsLeaderboard() {
  return useQuery({
    queryKey: ['points-leaderboard'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('purama_points')
        .select('user_id, balance, lifetime_earned, streak_days')
        .order('lifetime_earned', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
  });
}

export function getStreakMultiplier(days: number): number {
  if (days >= 100) return 10;
  if (days >= 60) return 7;
  if (days >= 30) return 5;
  if (days >= 14) return 3;
  if (days >= 7) return 2;
  return 1;
}

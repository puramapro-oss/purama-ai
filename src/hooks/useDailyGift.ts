import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

export interface GiftResult {
  type: string;
  value: string;
  label: string;
  alreadyClaimed: boolean;
}

export function useTodaysGift() {
  const { user } = useAuth();
  const today = new Date().toISOString().split('T')[0];

  return useQuery({
    queryKey: ['daily-gift', user?.id, today],
    queryFn: async () => {
      if (!user) return null;
      const { data, error } = await supabase
        .from('daily_gifts')
        .select('*')
        .eq('user_id', user.id)
        .gte('opened_at', `${today}T00:00:00`)
        .lte('opened_at', `${today}T23:59:59`)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: !!user,
  });
}

export function useOpenGift() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (): Promise<GiftResult> => {
      if (!user) throw new Error('Non connecté');
      const { data, error } = await supabase.rpc('claim_daily_gift');
      if (error) throw error;
      const result = data as Record<string, unknown>;
      return {
        type: String(result.gift_type),
        value: String(result.gift_value),
        label: String(result.label),
        alreadyClaimed: Boolean(result.already_claimed),
      };
    },
    onSuccess: (gift) => {
      queryClient.invalidateQueries({ queryKey: ['daily-gift'] });
      queryClient.invalidateQueries({ queryKey: ['points'] });
      toast.success(gift.label);
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Erreur lors de l\'ouverture du coffre');
    },
  });
}

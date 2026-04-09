import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import { toast } from 'sonner';

interface GiftResult {
  type: string;
  value: string;
  label: string;
}

const GIFT_TABLE: { weight: number; type: string; values: string[]; label: (v: string) => string }[] = [
  { weight: 40, type: 'points', values: ['5', '10', '15', '20'], label: (v) => `+${v} points` },
  { weight: 25, type: 'coupon', values: ['5', '10'], label: (v) => `-${v}% sur ton prochain mois` },
  { weight: 15, type: 'ticket', values: ['1'], label: () => '+1 ticket tirage mensuel' },
  { weight: 10, type: 'credits', values: ['3'], label: () => '+3 crédits agents' },
  { weight: 5, type: 'coupon_big', values: ['20'], label: (v) => `-${v}% pendant 3 jours` },
  { weight: 3, type: 'points_big', values: ['50', '100'], label: (v) => `+${v} points` },
  { weight: 2, type: 'coupon_mega', values: ['50'], label: (v) => `-${v}% pendant 24h` },
];

function rollGift(streakDays: number): GiftResult {
  const totalWeight = GIFT_TABLE.reduce((s, g) => s + g.weight, 0);
  let roll = Math.random() * totalWeight;

  for (const gift of GIFT_TABLE) {
    roll -= gift.weight;
    if (roll <= 0) {
      const value = gift.values[Math.floor(Math.random() * gift.values.length)];
      // Streak 7j+ = min coupon 10%
      if (streakDays >= 7 && gift.type === 'coupon' && Number(value) < 10) {
        return { type: 'coupon', value: '10', label: '-10% sur ton prochain mois' };
      }
      return { type: gift.type, value, label: gift.label(value) };
    }
  }

  return { type: 'points', value: '10', label: '+10 points' };
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
    mutationFn: async (streakDays: number): Promise<GiftResult> => {
      if (!user) throw new Error('Non connecté');

      const gift = rollGift(streakDays);

      const { error } = await supabase
        .from('daily_gifts')
        .insert({
          user_id: user.id,
          gift_type: gift.type,
          gift_value: gift.value,
          streak_count: streakDays,
        });
      if (error) throw error;

      return gift;
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

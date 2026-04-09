import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export function useCurrentDraw() {
  return useQuery({
    queryKey: ['current-draw'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lottery_draws')
        .select('*')
        .in('status', ['upcoming', 'live'])
        .order('draw_date', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useMyTickets(drawId?: string) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-tickets', user?.id, drawId],
    queryFn: async () => {
      if (!user) return [];
      let query = supabase
        .from('lottery_tickets')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (drawId) {
        query = query.eq('draw_id', drawId);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

export function usePastDraws() {
  return useQuery({
    queryKey: ['past-draws'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lottery_draws')
        .select('*')
        .eq('status', 'completed')
        .order('draw_date', { ascending: false })
        .limit(12);
      if (error) throw error;
      return data || [];
    },
  });
}

export function useDrawWinners(drawId?: string) {
  return useQuery({
    queryKey: ['draw-winners', drawId],
    queryFn: async () => {
      if (!drawId) return [];
      const { data, error } = await supabase
        .from('lottery_winners')
        .select('*')
        .eq('draw_id', drawId)
        .order('rank', { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!drawId,
  });
}

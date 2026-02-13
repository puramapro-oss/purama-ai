import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export function useActiveConcours() {
  return useQuery({
    queryKey: ['active-concours'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('concours')
        .select('*')
        .eq('statut', 'actif')
        .order('date_fin', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });
}

export function usePastConcours() {
  return useQuery({
    queryKey: ['past-concours'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('concours')
        .select('*')
        .eq('statut', 'termine')
        .order('date_fin', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
  });
}

export function useMyParticipations() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['my-participations', user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from('participations_concours')
        .select('*')
        .eq('user_id', user.id);
      if (error) throw error;
      return data || [];
    },
    enabled: !!user,
  });
}

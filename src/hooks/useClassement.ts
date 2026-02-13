import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export function useActiveClassement() {
  return useQuery({
    queryKey: ['active-classement'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('classement_mensuel')
        .select('*')
        .eq('statut', 'actif')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useClassementResults(classementId?: string) {
  return useQuery({
    queryKey: ['classement-results', classementId],
    queryFn: async () => {
      if (!classementId) return [];
      const { data, error } = await supabase
        .from('candidatures_classement')
        .select('*')
        .eq('classement_id', classementId)
        .order('rang', { ascending: true, nullsFirst: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    enabled: !!classementId,
  });
}

export function usePastClassements() {
  return useQuery({
    queryKey: ['past-classements'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('classement_mensuel')
        .select('*')
        .eq('statut', 'termine')
        .order('created_at', { ascending: false })
        .limit(12);
      if (error) throw error;
      return data || [];
    },
  });
}

export function useSubmitCandidature() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: {
      classement_id: string;
      site_url: string;
      description_impact: string;
      categorie_impact: string;
    }) => {
      if (!user) throw new Error('Non authentifié');
      const { data, error } = await supabase
        .from('candidatures_classement')
        .insert({
          classement_id: params.classement_id,
          user_id: user.id,
          site_url: params.site_url,
          description_impact: params.description_impact,
          categorie_impact: params.categorie_impact,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['classement-results'] });
    },
  });
}

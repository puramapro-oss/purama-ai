import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export function useFaqArticles() {
  return useQuery({
    queryKey: ['faq-articles'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('faq_articles')
        .select('*')
        .order('sort_order', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });
}

export function useCrossPromos() {
  return useQuery({
    queryKey: ['cross-promos'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cross_promos')
        .select('*')
        .eq('source_app', 'purama_ai')
        .eq('is_active', true);
      if (error) throw error;
      return data || [];
    },
  });
}

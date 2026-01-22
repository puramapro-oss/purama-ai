import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string;
  icon: string | null;
  color: string | null;
  features: string[] | Record<string, unknown>;
  is_active: boolean;
  is_premium: boolean;
  created_at: string;
}

export function useAgents(category?: string) {
  return useQuery({
    queryKey: ['agents', category],
    queryFn: async () => {
      let query = supabase
        .from('agents')
        .select('*')
        .eq('is_active', true)
        .order('name');

      if (category && category !== 'all') {
        query = query.eq('category', category);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return data as Agent[];
    },
  });
}

export function useAgentCategories() {
  return useQuery({
    queryKey: ['agent-categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agents')
        .select('category')
        .eq('is_active', true);

      if (error) {
        throw error;
      }

      const categories = [...new Set(data.map((a) => a.category))].sort();
      return categories;
    },
  });
}

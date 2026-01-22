import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Agent } from './useAgents';
import { useAuth } from './useAuth';

export function useAgent(slug: string) {
  return useQuery({
    queryKey: ['agent', slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .eq('slug', slug)
        .eq('is_active', true)
        .maybeSingle();

      if (error) {
        throw error;
      }

      if (!data) {
        throw new Error('Agent not found');
      }

      return data as Agent;
    },
    enabled: !!slug,
  });
}

export function useActivateAgent() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentId, actionType = 'activate' }: { agentId: string; actionType?: string }) => {
      if (!user) throw new Error('Not authenticated');

      const { data, error } = await supabase
        .from('agent_usage')
        .insert({
          user_id: user.id,
          agent_id: agentId,
          action_type: actionType,
          status: 'active',
        })
        .select()
        .single();

      if (error) {
        throw error;
      }

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agent-usage'] });
    },
  });
}

export function useAgentUsage(agentId?: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['agent-usage', agentId, user?.id],
    queryFn: async () => {
      if (!user) return null;

      let query = supabase
        .from('agent_usage')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (agentId) {
        query = query.eq('agent_id', agentId);
      }

      const { data, error } = await query;

      if (error) {
        throw error;
      }

      return data;
    },
    enabled: !!user,
  });
}

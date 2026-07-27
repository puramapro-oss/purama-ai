import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

/** État KARTA d'un agent créé — même table que les 12 employés fixes (karta_agent_state),
 * juste une clé agent_type différente (`custom:<creator_agents.id>`). */
export interface CustomKartaState {
  id: string;
  user_id: string;
  agent_type: string;
  is_enabled: boolean;
  autonomy_level: number;
  kill_switch: boolean;
  simulation_mode: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
}

export interface CustomKartaPendingAction {
  id: string;
  run_id: string;
  agent_type: string;
  tool_name: string;
  tool_params: unknown;
  status: string;
  created_at: string;
}

export interface CustomKartaRun {
  id: string;
  agent_type: string;
  trigger_type: string;
  mode: string;
  status: string;
  decision: string | null;
  result_summary: string | null;
  error_message: string | null;
  claude_mock: boolean;
  started_at: string;
}

const agentTypeFor = (agentId: string) => `custom:${agentId}`;

export function useCustomAgentKartaState(agentId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['custom-agent-karta-state', agentId],
    enabled: !!user && !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_agent_state')
        .select('*')
        .eq('user_id', user!.id)
        .eq('agent_type', agentTypeFor(agentId!))
        .maybeSingle();

      if (error) throw error;
      return data as CustomKartaState | null;
    },
  });
}

/** Écrit l'activation KARTA / autonomie / kill switch / simulation — RLS garantit user_id = auth.uid(),
 * la ligne est auto-créée (valeurs par défaut sûres : niveau 1, simulation) au 1er cycle si absente. */
export function useUpdateCustomAgentKartaState(agentId: string | undefined) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      patch: Partial<Pick<CustomKartaState, 'is_enabled' | 'autonomy_level' | 'kill_switch' | 'simulation_mode'>>,
    ) => {
      if (!user || !agentId) throw new Error('Non authentifié');

      const { error } = await supabase.from('karta_agent_state').upsert(
        {
          user_id: user.id,
          agent_type: agentTypeFor(agentId),
          ...patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,agent_type' },
      );

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-agent-karta-state', agentId] });
    },
  });
}

export function useCustomAgentKartaRuns(agentId: string | undefined, limit = 20) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['custom-agent-karta-runs', agentId, limit],
    enabled: !!user && !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_runs')
        .select('*')
        .eq('user_id', user!.id)
        .eq('agent_type', agentTypeFor(agentId!))
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as CustomKartaRun[];
    },
  });
}

/** Actions en attente de validation humaine pour cet agent créé (même mécanisme que les employés fixes). */
export function useCustomAgentPendingActions(agentId: string | undefined) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['custom-agent-pending-actions', agentId],
    enabled: !!user && !!agentId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_pending_actions')
        .select('*')
        .eq('user_id', user!.id)
        .eq('agent_type', agentTypeFor(agentId!))
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as CustomKartaPendingAction[];
    },
  });
}

/** "Tester maintenant" — passe par le proxy edge function (vérifie la propriété côté serveur,
 * le token admin KARTA ne quitte jamais le serveur). */
export function useTriggerCustomAgent() {
  return useMutation({
    mutationFn: async (agentId: string) => {
      const { data, error } = await supabase.functions.invoke('karta-trigger-custom', {
        body: { agentId },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { ok: true; queued: boolean };
    },
  });
}

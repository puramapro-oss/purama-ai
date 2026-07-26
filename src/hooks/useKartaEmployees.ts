import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import type { Agent } from './useAgents';

/**
 * Les 12 agents "action" KARTA (customer-facing, cf karta/src/agents/actionAgents.ts).
 * Source de vérité = karta/src/engine/types.ts ACTION_AGENT_TYPES — dupliqué ici volontairement
 * (le frontend ne peut pas importer le projet karta/, backend Node séparé).
 */
export const ACTION_AGENT_SLUGS = [
  'repondeur-intelligent',
  'campagnes-par-courriel',
  'pro-de-la-sensibilisation-au-froid',
  'newsletter-genie',
  'facture-pro',
  'chasseur-de-paiements',
  'rapports-financiers',
  'crm-intelligent',
  'machine-de-suivi',
  'maitre-des-publicites',
  'planificateur-d-appels',
  'reservation-intelligente',
] as const;

export type ActionAgentSlug = (typeof ACTION_AGENT_SLUGS)[number];

export interface KartaAgentState {
  id: string;
  user_id: string;
  agent_type: string;
  is_enabled: boolean;
  autonomy_level: number;
  kill_switch: boolean;
  simulation_mode: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  created_at: string;
  updated_at: string;
}

export interface KartaRun {
  id: string;
  user_id: string;
  agent_type: string;
  trigger_type: string;
  trigger_source: string | null;
  mode: string;
  status: string;
  input_summary: string | null;
  decision: string | null;
  tools_used: unknown;
  result_summary: string | null;
  error_message: string | null;
  claude_mock: boolean;
  duration_ms: number | null;
  started_at: string;
  finished_at: string | null;
}

/** Métadonnées d'affichage (nom, icône, catégorie...) des 12 agents "employés", depuis la table `agents` — 1 source de vérité. */
export function useEmployeeAgents() {
  return useQuery({
    queryKey: ['karta-employee-agents'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agents')
        .select('*')
        .in('slug', ACTION_AGENT_SLUGS as unknown as string[]);

      if (error) throw error;
      return (data ?? []) as Agent[];
    },
  });
}

/** État KARTA (autonomie, kill switch, simulation) par agent pour l'utilisateur courant. */
export function useKartaAgentStates() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['karta-agent-states', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_agent_state')
        .select('*')
        .eq('user_id', user!.id)
        .in('agent_type', ACTION_AGENT_SLUGS as unknown as string[]);

      if (error) throw error;
      const map = new Map<string, KartaAgentState>();
      (data ?? []).forEach((row) => map.set(row.agent_type, row as KartaAgentState));
      return map;
    },
  });
}

interface UpdateStateInput {
  agentType: ActionAgentSlug;
  patch: Partial<Pick<KartaAgentState, 'is_enabled' | 'autonomy_level' | 'kill_switch' | 'simulation_mode'>>;
}

/** Écrit un changement de réglage (activation, niveau d'autonomie, kill switch) — RLS garantit user_id = auth.uid(). */
export function useUpdateKartaAgentState() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ agentType, patch }: UpdateStateInput) => {
      if (!user) throw new Error('Non authentifié');

      const { error } = await supabase.from('karta_agent_state').upsert(
        {
          user_id: user.id,
          agent_type: agentType,
          ...patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,agent_type' },
      );

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['karta-agent-states', user?.id] });
    },
  });
}

/** Timeline d'activité : dernières exécutions réelles (karta_runs), tous agents "employés" confondus. */
export function useKartaRuns(limit = 30) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['karta-runs', user?.id, limit],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_runs')
        .select('*')
        .eq('user_id', user!.id)
        .in('agent_type', ACTION_AGENT_SLUGS as unknown as string[])
        .order('started_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      return (data ?? []) as KartaRun[];
    },
  });
}

/** true dès qu'au moins 1 des 12 employés est activé — sert à déclencher l'onboarding "Embauche ton 1er employé IA". */
export function useHasAnyEmployeeHired() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['karta-has-employee', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_agent_state')
        .select('id')
        .eq('user_id', user!.id)
        .eq('is_enabled', true)
        .in('agent_type', ACTION_AGENT_SLUGS as unknown as string[])
        .limit(1);

      if (error) throw error;
      return (data ?? []).length > 0;
    },
  });
}

/**
 * Déclenche un cycle réel via le proxy sécurisé `karta-trigger` (edge function — le token admin
 * KARTA ne quitte jamais le serveur). Utilisé par l'onboarding pour la "première action" réelle.
 */
export function useTriggerKartaAgent() {
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (agentType: ActionAgentSlug) => {
      if (!user) throw new Error('Non authentifié');

      const { data, error } = await supabase.functions.invoke('karta-trigger', {
        body: { agentType },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as { ok: true; queued: boolean };
    },
  });
}

/**
 * Attend qu'un nouveau `karta_runs` apparaisse pour cet agent après `sinceIso` (poll court, ~15s max).
 * Le trigger est asynchrone (mis en queue BullMQ) : on ne peut pas afficher le vrai résultat sans attendre.
 */
export function usePollLatestRun(agentType: ActionAgentSlug | null, sinceIso: string | null) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['karta-poll-run', user?.id, agentType, sinceIso],
    enabled: !!user && !!agentType && !!sinceIso,
    refetchInterval: (query) => (query.state.data ? false : 1500),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_runs')
        .select('*')
        .eq('user_id', user!.id)
        .eq('agent_type', agentType!)
        .gte('started_at', sinceIso!)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      return (data as KartaRun | null) ?? null;
    },
  });
}

/** Stats réelles agrégées depuis karta_runs des 30 derniers jours — 0 si aucune donnée (jamais de faux chiffres). */
export function useKartaStats() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['karta-stats', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - 30);

      const { data, error } = await supabase
        .from('karta_runs')
        .select('agent_type, status, started_at')
        .eq('user_id', user!.id)
        .in('agent_type', ACTION_AGENT_SLUGS as unknown as string[])
        .gte('started_at', since.toISOString());

      if (error) throw error;
      return data ?? [];
    },
  });

  const rows = query.data ?? [];
  const total = rows.length;
  const success = rows.filter((r) => r.status === 'success').length;
  const awaitingApproval = rows.filter((r) => r.status === 'awaiting_approval').length;
  const errors = rows.filter((r) => r.status === 'error').length;
  const successRate = total > 0 ? Math.round((success / total) * 100) : 0;

  return { isLoading: query.isLoading, total, success, awaitingApproval, errors, successRate };
}

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { createRequestDeadline } from '@/lib/request-deadline';
import { createRequestScope } from '@/lib/request-scope';
import { useAuth } from './useAuth';
import { useRequestScope } from './useRequestScope';

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
  const userId = user?.id;

  return useQuery({
    queryKey: ['custom-agent-karta-state', userId, agentId],
    enabled: !!userId && !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_agent_state')
        .select('*')
        .eq('user_id', userId!)
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
  const userId = user?.id;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      patch: Partial<Pick<CustomKartaState, 'is_enabled' | 'autonomy_level' | 'kill_switch' | 'simulation_mode'>>,
    ) => {
      if (!userId || !agentId) throw new Error('Non authentifié');

      const { error } = await supabase.from('karta_agent_state').upsert(
        {
          user_id: userId,
          agent_type: agentTypeFor(agentId),
          ...patch,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,agent_type' },
      );

      if (error) throw error;
      // Bind cache invalidation to the owner of this write, even if the hook
      // receives a new identity while the request is in flight.
      return { userId, agentId };
    },
    onSuccess: (owner) => {
      queryClient.invalidateQueries({ queryKey: ['custom-agent-karta-state', owner.userId, owner.agentId] });
    },
  });
}

export function useCustomAgentKartaRuns(agentId: string | undefined, limit = 20) {
  const { user } = useAuth();
  const userId = user?.id;

  return useQuery({
    queryKey: ['custom-agent-karta-runs', userId, agentId, limit],
    enabled: !!userId && !!agentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_runs')
        .select('*')
        .eq('user_id', userId!)
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
  const userId = user?.id;

  return useQuery({
    queryKey: ['custom-agent-pending-actions', userId, agentId],
    enabled: !!userId && !!agentId,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('karta_pending_actions')
        .select('*')
        .eq('user_id', userId!)
        .eq('agent_type', agentTypeFor(agentId!))
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as CustomKartaPendingAction[];
    },
  });
}

const TRIGGER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TRIGGER_JOB = /^karta-v2-dedupe-[0-9a-f]{64}$/;
const TRIGGER_UNCONFIRMED = 'Le déclenchement n’est pas confirmé. Réessaie le même envoi ou consulte l’activité de cet agent.';
const TRIGGER_SESSION = 'Ta session a changé. Rouvre cet agent avec le compte souhaité.';
const TRIGGER_STORAGE = 'Le suivi de ce déclenchement ne peut pas être conservé. Vérifie le stockage du navigateur avant de continuer.';
const TRIGGER_BUSY = 'Un déclenchement est déjà en cours de vérification.';
const TRIGGER_LOCKS = 'Ce navigateur ne permet pas de sécuriser ce déclenchement. Ouvre PURAMA en HTTPS dans un navigateur à jour.';

interface CustomTriggerReceipt {
  ok: true;
  queued: true;
  requestId: string;
  jobId: string;
  executionKey: string;
}

/** Like brief submissions, persist only the delivery identifier, before any write.
 * The server's manual trigger belongs to an owner/agent, not to a chat session.
 * An uncertain delivery survives navigation and logout; it has no client TTL.
 * Never replace an unreadable record with a new intention. */
function pendingTrigger(key: string): string {
  try {
    const retained = localStorage.getItem(key);
    if (retained !== null) {
      if (!TRIGGER_UUID.test(retained)) throw new Error();
      return retained;
    }
    const requestId = crypto.randomUUID();
    localStorage.setItem(key, requestId);
    if (localStorage.getItem(key) !== requestId) throw new Error();
    return requestId;
  } catch { throw new Error(TRIGGER_STORAGE); }
}

/** "Tester maintenant" uses the existing KARTA delivery protocol. Cancelling a
 * transport never proves non-admission and never erases an uncertain intention. */
export function useTriggerCustomAgent(agentId: string | undefined, sessionId: string) {
  const { user } = useAuth();
  const userId = user?.id;
  const scopeKey = JSON.stringify([userId, agentId, sessionId]);
  const captureScope = useRequestScope(scopeKey);
  const [requests] = useState(createRequestScope);
  useLayoutEffect(() => () => requests.invalidate(), [scopeKey, requests]);

  return useMutation({
    mutationKey: ['custom-agent-trigger', userId, agentId, sessionId],
    retry: false,
    mutationFn: async (requestedAgentId: string): Promise<CustomTriggerReceipt> => {
      const isCurrent = captureScope();
      if (!isCurrent() || !userId || !agentId || !sessionId || requestedAgentId !== agentId
        || !TRIGGER_UUID.test(userId) || !TRIGGER_UUID.test(agentId)) throw new Error(TRIGGER_SESSION);
      const request = requests.begin('trigger');
      if (!request) throw new Error(TRIGGER_BUSY);
      const deadline = createRequestDeadline(15_000, request.signal);
      const storageKey = `purama:karta-custom-trigger:v1:${userId.toLowerCase()}:${agentId.toLowerCase()}`;
      let accepted: CustomTriggerReceipt | undefined;
      const checkCurrent = () => {
        deadline.check();
        if (!isCurrent() || !request.current()) throw new Error(TRIGGER_SESSION);
      };
      try {
        if (typeof navigator.locks?.request !== 'function') throw new Error(TRIGGER_LOCKS);
        // Reservation, admission and acknowledgement retirement share one native
        // origin lock. A competing tab fails immediately instead of waiting for
        // a suspended tab, and no unsafe storage-only fallback is permitted.
        return await deadline.wait(() => navigator.locks.request(storageKey, { mode: 'exclusive', ifAvailable: true }, async (lock): Promise<CustomTriggerReceipt> => {
          if (!lock) throw new Error(TRIGGER_BUSY);
          checkCurrent();
          const requestId = pendingTrigger(storageKey);
          const { data: authData, error: authError } = await deadline.wait(() => supabase.auth.getSession());
          checkCurrent();
          if (authError || authData.session?.user.id !== userId) throw new Error(TRIGGER_SESSION);
          // The explicit owner-bound token prevents a late SDK read from selecting
          // another account. The Edge still authenticates it and checks ownership.
          const { data, error } = await deadline.wait(() => supabase.functions.invoke('karta-trigger-custom', {
            body: { agentId: agentId.toLowerCase(), requestId },
            headers: { Authorization: `Bearer ${authData.session.access_token}` },
            signal: request.signal,
            timeout: 15_000,
          }));
          checkCurrent();
          if (error || !data || data.ok !== true || data.queued !== true || data.requestId !== requestId
            || typeof data.jobId !== 'string' || !TRIGGER_JOB.test(data.jobId)
            || data.executionKey !== `queue:v2:${data.jobId}`) throw new Error(TRIGGER_UNCONFIRMED);
          accepted = { ok: true, queued: true, requestId, jobId: data.jobId, executionKey: data.executionKey };
          // A stale response must not erase a newer delivery, including across tabs.
          try {
            if (localStorage.getItem(storageKey) === requestId) localStorage.removeItem(storageKey);
          } catch { /* Retaining a confirmed key is safer than inventing a new one. */ }
          return accepted;
        }));
      } catch (error) {
        // Lock release can finish after the outer deadline. Once a valid receipt
        // retired this intention, never downgrade it to an unknown outcome.
        if (accepted) return accepted;
        if (error instanceof Error && [TRIGGER_STORAGE, TRIGGER_SESSION, TRIGGER_BUSY, TRIGGER_LOCKS].includes(error.message)) throw error;
        throw new Error(TRIGGER_UNCONFIRMED);
      } finally {
        // Abort late work even when an adapter ignored its transport timeout.
        if (request.current()) requests.cancel('trigger');
        deadline.close();
      }
    },
  });
}

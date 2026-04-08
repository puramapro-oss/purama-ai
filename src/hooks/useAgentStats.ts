import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export interface AgentUsageRow {
  id: string;
  agent_id: string;
  action_type: string;
  status: string;
  created_at: string;
}

export interface AgentStat {
  agent_id: string;
  total: number;
  thisMonth: number;
  lastUsedAt: string | null;
}

const startOfMonth = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
};

/**
 * Fetch all agent_usage rows for the current user.
 */
export function useAgentUsage(days = 90) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['agent-usage', user?.id, days],
    enabled: !!user,
    queryFn: async () => {
      const since = new Date();
      since.setDate(since.getDate() - days);

      const { data, error } = await supabase
        .from('agent_usage')
        .select('id, agent_id, action_type, status, created_at')
        .eq('user_id', user!.id)
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false });

      if (error) throw error;
      return (data ?? []) as AgentUsageRow[];
    },
  });
}

/**
 * Aggregate per-agent statistics from agent_usage.
 */
export function useAgentStats() {
  const usage = useAgentUsage(365);

  const map = new Map<string, AgentStat>();
  const monthStart = startOfMonth();

  (usage.data ?? []).forEach((row) => {
    const existing = map.get(row.agent_id) ?? {
      agent_id: row.agent_id,
      total: 0,
      thisMonth: 0,
      lastUsedAt: null,
    };
    existing.total += 1;
    if (row.created_at >= monthStart) existing.thisMonth += 1;
    if (!existing.lastUsedAt || row.created_at > existing.lastUsedAt) {
      existing.lastUsedAt = row.created_at;
    }
    map.set(row.agent_id, existing);
  });

  return {
    isLoading: usage.isLoading,
    statsByAgent: map,
    raw: usage.data ?? [],
    totalThisMonth: Array.from(map.values()).reduce((s, v) => s + v.thisMonth, 0),
    totalAllTime: Array.from(map.values()).reduce((s, v) => s + v.total, 0),
  };
}

/**
 * Time series for the last `days` days, bucketed by day.
 */
export function useAgentDailySeries(days = 30) {
  const usage = useAgentUsage(days);

  const buckets: Record<string, number> = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    buckets[key] = 0;
  }

  (usage.data ?? []).forEach((row) => {
    const key = row.created_at.slice(0, 10);
    if (key in buckets) buckets[key] += 1;
  });

  const series = Object.entries(buckets).map(([day, value]) => ({
    day: day.slice(5),
    value,
  }));

  return { series, isLoading: usage.isLoading };
}

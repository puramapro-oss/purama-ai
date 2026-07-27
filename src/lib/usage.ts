// Usage tracking — counts user executions across all agents for the current month.
// Reset is implicit: we always query rows WHERE created_at >= start of current month UTC.
import { supabase } from '@/integrations/supabase/client';
import { getPlan, PLANS, type Plan } from './plans';
import { isSuperAdmin } from './constants';

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

function startOfMonthISO(): string {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function daysUntilNextMonth(): number {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.ceil((next.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export interface UsageSnapshot {
  used: number;
  limit: number;
  percent: number;
  plan: Plan;
  days_until_reset: number;
  by_agent: {
    email: number;
    compta: number;
    partner: number;
    legal: number;
    creator: number;
    /** Les 12 employés IA KARTA (marketplace_ai + agents créés en exécution réelle) — karta_runs. */
    karta: number;
    /** Les agents "chat" du marketplace (agent_usage) — hors KARTA. */
    marketplace: number;
  };
  /** Temps gagné estimé ce mois (heuristique documentée : ~5 min par action réelle). */
  hours_saved: number;
  /** € réellement récupérés ce mois — somme des factures émises (compta_invoices) marquées payées. */
  money_recovered: number;
}

/** Minutes gagnées par action réelle — heuristique documentée (pas de faux chiffre, juste une estimation raisonnable et annoncée comme telle). */
const MINUTES_SAVED_PER_ACTION = 5;

async function countTable(
  table: string,
  userId: string,
  since: string,
  extraFilter?: { col: string; op: string; val: string },
  dateCol = 'created_at',
): Promise<number> {
  let q = sb()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte(dateCol, since);
  if (extraFilter) q = q[extraFilter.op](extraFilter.col, extraFilter.val);
  const { count, error } = await q;
  if (error) {
    console.warn(`[usage] count ${table} failed`, error);
    return 0;
  }
  return count ?? 0;
}

export async function getUsageSnapshot(userId: string, userEmail?: string | null): Promise<UsageSnapshot> {
  const since = startOfMonthISO();

  // Super admin → forced unlimited (Ultime), bypass DB lookup
  const superAdmin = isSuperAdmin(userEmail);

  // Fetch the user's plan (from purama_ai.subscriptions if any) — 'active' (payé) ou 'trialing'
  // (essai 14 jours sans carte, cf start_trial() RPC) tant que trial_ends_at n'est pas dépassé.
  let planType = superAdmin ? 'ultime' : 'free';
  if (!superAdmin) {
    try {
      const { data } = await sb()
        .from('subscriptions')
        .select('plan_type, status, trial_ends_at')
        .eq('user_id', userId)
        .maybeSingle();
      const isActive = data?.status === 'active';
      const isTrialing = data?.status === 'trialing' && data?.trial_ends_at && new Date(data.trial_ends_at) > new Date();
      if (data?.plan_type && (isActive || isTrialing)) planType = data.plan_type;
    } catch { /* ignore */ }
  }

  const plan = superAdmin
    ? { ...PLANS.ultime, monthly_executions: Number.MAX_SAFE_INTEGER, custom_agents_max: 999, agents_included: -1 }
    : getPlan(planType);

  // Run all counts in parallel
  const [
    emailCount, comptaCount, partnerCount, legalChat, legalDoc, legalCase, creatorCount,
    kartaCount, marketplaceCount, moneyRecovered,
  ] = await Promise.all([
    countTable('email_agent_logs', userId, since),
    countTable('compta_transactions', userId, since),
    countTable('partner_emails', userId, since),
    countTable('legal_chat_history', userId, since, { col: 'role', op: 'eq', val: 'assistant' }),
    countTable('legal_documents', userId, since),
    countTable('legal_cases', userId, since),
    countTable('creator_agent_runs', userId, since),
    countTable('karta_runs', userId, since, undefined, 'started_at'),
    countTable('agent_usage', userId, since),
    sumPaidInvoicesThisMonth(userId, since),
  ]);

  const by_agent = {
    email: emailCount,
    compta: comptaCount,
    partner: partnerCount,
    legal: legalChat + legalDoc + legalCase,
    creator: creatorCount,
    karta: kartaCount,
    marketplace: marketplaceCount,
  };
  const used = Object.values(by_agent).reduce((s, n) => s + n, 0);
  const percent = plan.monthly_executions > 0
    ? Math.min(100, Math.round((used / plan.monthly_executions) * 100))
    : 0;

  return {
    used,
    limit: plan.monthly_executions,
    percent,
    plan,
    days_until_reset: daysUntilNextMonth(),
    by_agent,
    hours_saved: Math.round((used * MINUTES_SAVED_PER_ACTION) / 60),
    money_recovered: moneyRecovered,
  };
}

/** Somme réelle des factures émises et payées ce mois (compta_invoices.total_ttc, type='emise', payment_date >= since). */
async function sumPaidInvoicesThisMonth(userId: string, since: string): Promise<number> {
  const { data, error } = await sb()
    .from('compta_invoices')
    .select('total_ttc')
    .eq('user_id', userId)
    .eq('type', 'emise')
    .eq('status', 'paid')
    .gte('payment_date', since.slice(0, 10));
  if (error) {
    console.warn('[usage] sumPaidInvoicesThisMonth failed', error);
    return 0;
  }
  return (data ?? []).reduce((sum: number, row: { total_ttc: number }) => sum + Number(row.total_ttc ?? 0), 0);
}

export function colorForPercent(p: number): string {
  if (p < 50) return 'from-emerald-400 to-emerald-500';
  if (p < 75) return 'from-emerald-400 via-yellow-400 to-yellow-500';
  if (p < 90) return 'from-yellow-400 via-orange-400 to-orange-500';
  return 'from-orange-500 via-red-500 to-red-600';
}

export function textColorForPercent(p: number): string {
  if (p < 50) return 'text-emerald-400';
  if (p < 75) return 'text-yellow-400';
  if (p < 90) return 'text-orange-400';
  return 'text-red-400';
}

export function formatExecutions(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace('.0', '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace('.0', '') + 'k';
  return n.toString();
}

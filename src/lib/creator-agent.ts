// Frontend client for the Creator Agent (meta-agent that builds custom agents).
import { supabase } from '@/integrations/supabase/client';

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

// =============================================================
// Types
// =============================================================
export type AgentCategory =
  | 'productivity' | 'marketing' | 'sales' | 'support'
  | 'content' | 'dev' | 'finance' | 'autre';

export type AgentModel = 'claude-sonnet-4-20250514' | 'claude-haiku-4-5-20251001';

export type RunTrigger = 'chat' | 'manual' | 'cron' | 'webhook' | 'api';
export type RunStatus = 'pending' | 'running' | 'success' | 'error';

export interface CreatorAgent {
  id: string;
  user_id: string | null;
  name: string;
  slug: string;
  description: string | null;
  emoji: string;
  color: string;
  category: AgentCategory | null;
  system_prompt: string;
  model: AgentModel;
  temperature: number;
  max_tokens: number;
  tools_enabled: string[];
  schedule_enabled: boolean;
  schedule_cron: string | null;
  schedule_input: Record<string, unknown> | null;
  last_scheduled_run: string | null;
  /** true = KARTA Engine exécute réellement cet agent (outils, autonomie, planification), pas juste le chat. */
  karta_enabled: boolean;
  is_active: boolean;
  is_public: boolean;
  is_template: boolean;
  total_runs: number;
  total_tokens: number;
  avg_rating: number | null;
  cloned_from: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatorAgentRun {
  id: string;
  user_id: string;
  agent_id: string;
  trigger: RunTrigger;
  input: string | null;
  output: string | null;
  status: RunStatus;
  error_message: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface CreatorAgentChatMessage {
  id: string;
  user_id: string;
  agent_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens: number | null;
  created_at: string;
}

// =============================================================
// Static metadata
// =============================================================
export const CATEGORIES: { value: AgentCategory; label: string; emoji: string; color: string }[] = [
  { value: 'productivity', label: 'Productivité', emoji: '⚡', color: '#8B5CF6' },
  { value: 'marketing', label: 'Marketing', emoji: '📢', color: '#10B981' },
  { value: 'sales', label: 'Ventes', emoji: '🎯', color: '#EF4444' },
  { value: 'support', label: 'Support', emoji: '💬', color: '#06B6D4' },
  { value: 'content', label: 'Contenu', emoji: '📝', color: '#EC4899' },
  { value: 'dev', label: 'Dev', emoji: '💻', color: '#6366F1' },
  { value: 'finance', label: 'Finance', emoji: '💰', color: '#F59E0B' },
  { value: 'autre', label: 'Autre', emoji: '📦', color: '#94A3B8' },
];

export const MODELS: { value: AgentModel; label: string; description: string }[] = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4', description: 'Le plus puissant. Recommandé pour 90% des cas.' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: 'Plus rapide et moins cher. Pour les tâches répétitives.' },
];

/** Outils réellement exécutables par KARTA Engine pour un agent créé (cf karta/src/tools/customRegistry.ts
 * — 1 seule source de vérité pour les noms, dupliquée ici et côté edge function faute de pouvoir
 * importer un projet Node depuis le frontend Vite). */
export const TOOL_OPTIONS = [
  { value: 'supabase_select', label: 'Lire ses données (factures, prospects, notes déjà enregistrées)' },
  { value: 'supabase_upsert', label: 'Enregistrer une donnée (lead, statut, note...)' },
  { value: 'gmail_create_draft', label: 'Préparer un brouillon email (jamais envoyé sans validation)' },
  { value: 'gmail_send', label: 'Envoyer un email (toujours soumis à validation par défaut)' },
  { value: 'calendar_create_event', label: 'Créer un événement Google Calendar' },
  { value: 'generate_pdf', label: 'Générer un PDF (rapport, facture, résumé...)' },
  { value: 'web_search', label: 'Recherche web en temps réel' },
  { value: 'send_notification', label: "Notifier l'utilisateur (app/email) quand une décision est nécessaire" },
] as const;

/** Presets de planification "zéro jargon" — l'utilisateur ne voit jamais de syntaxe cron. */
export const SCHEDULE_PRESETS: { label: string; cron: string | null }[] = [
  { label: 'Seulement quand je clique sur "Tester"', cron: null },
  { label: 'Tous les jours à 8h', cron: '0 8 * * *' },
  { label: 'Tous les jours à 18h', cron: '0 18 * * *' },
  { label: 'Chaque lundi à 9h', cron: '0 9 * * 1' },
  { label: 'Toutes les heures', cron: '0 * * * *' },
  { label: 'Toutes les 30 minutes', cron: '*/30 * * * *' },
];

// =============================================================
// CRUD
// =============================================================
export async function listMyAgents(userId: string): Promise<CreatorAgent[]> {
  const { data, error } = await sb()
    .from('creator_agents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CreatorAgent[];
}

export async function listTemplates(): Promise<CreatorAgent[]> {
  const { data, error } = await sb()
    .from('creator_agents')
    .select('*')
    .eq('is_template', true)
    .order('name', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CreatorAgent[];
}

export async function listPublicAgents(): Promise<CreatorAgent[]> {
  const { data, error } = await sb()
    .from('creator_agents')
    .select('*')
    .eq('is_public', true)
    .eq('is_template', false)
    .order('total_runs', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as CreatorAgent[];
}

export async function getAgent(id: string): Promise<CreatorAgent> {
  const { data, error } = await sb()
    .from('creator_agents')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as CreatorAgent;
}

const slugify = (s: string): string =>
  s.toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'agent';

export async function createAgent(
  userId: string,
  agent: Omit<Partial<CreatorAgent>, 'id' | 'user_id'> & { name: string; system_prompt: string },
): Promise<CreatorAgent> {
  const slug = agent.slug || slugify(agent.name) + '-' + Date.now().toString(36);
  const { data, error } = await sb()
    .from('creator_agents')
    .insert({
      user_id: userId,
      slug,
      emoji: '🤖',
      color: '#8B5CF6',
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      max_tokens: 4000,
      tools_enabled: [],
      is_active: true,
      ...agent,
      is_template: false, // never let users create templates directly
    })
    .select()
    .single();
  if (error) throw error;
  return data as CreatorAgent;
}

export async function updateAgent(
  id: string,
  patch: Partial<CreatorAgent>,
): Promise<CreatorAgent> {
  // Strip unsafe fields
  const { id: _, user_id: __, created_at: ___, updated_at: ____, total_runs: _____, total_tokens: ______, is_template: _______, ...safe } = patch;
  void _; void __; void ___; void ____; void _____; void ______; void _______;
  const { data, error } = await sb()
    .from('creator_agents')
    .update(safe)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as CreatorAgent;
}

export async function deleteAgent(id: string): Promise<void> {
  const { error } = await sb().from('creator_agents').delete().eq('id', id);
  if (error) throw error;
}

export async function cloneTemplate(
  userId: string,
  templateId: string,
): Promise<CreatorAgent> {
  const tpl = await getAgent(templateId);
  return createAgent(userId, {
    name: tpl.name,
    description: tpl.description,
    emoji: tpl.emoji,
    color: tpl.color,
    category: tpl.category,
    system_prompt: tpl.system_prompt,
    model: tpl.model,
    temperature: tpl.temperature,
    max_tokens: tpl.max_tokens,
    tools_enabled: tpl.tools_enabled,
    cloned_from: tpl.id,
  });
}

// =============================================================
// CHAT (delegated to edge function)
// =============================================================
export async function chatWithAgent(
  agentId: string,
  sessionId: string,
  message: string,
): Promise<{ reply: string; tokens: number }> {
  const { data, error } = await supabase.functions.invoke('creator-agent-chat', {
    body: { agent_id: agentId, session_id: sessionId, message },
  });
  if (error) throw error;
  return data as { reply: string; tokens: number };
}

export async function listChatMessages(
  agentId: string,
  sessionId: string,
): Promise<CreatorAgentChatMessage[]> {
  const { data, error } = await sb()
    .from('creator_agent_chats')
    .select('*')
    .eq('agent_id', agentId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CreatorAgentChatMessage[];
}

// =============================================================
// RUN (one-shot execution)
// =============================================================
export async function runAgent(
  agentId: string,
  input: string,
): Promise<CreatorAgentRun> {
  const { data, error } = await supabase.functions.invoke('creator-agent-run', {
    body: { agent_id: agentId, input, trigger: 'manual' },
  });
  if (error) throw error;
  return data as CreatorAgentRun;
}

export async function listRuns(
  userId: string,
  opts: { agent_id?: string; limit?: number } = {},
): Promise<CreatorAgentRun[]> {
  let q = sb()
    .from('creator_agent_runs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.agent_id) q = q.eq('agent_id', opts.agent_id);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CreatorAgentRun[];
}

// =============================================================
// AI-ASSISTED GENERATION (delegated to edge function)
// =============================================================
export interface GeneratedAgent {
  name: string;
  slug: string;
  emoji: string;
  color: string;
  category: AgentCategory;
  description: string;
  system_prompt: string;
  suggested_tools: string[];
  suggested_model: AgentModel;
  suggested_temperature: number;
  suggested_schedule: string | null;
}

export async function generateAgent(description: string): Promise<GeneratedAgent> {
  const { data, error } = await supabase.functions.invoke('creator-agent-generate', {
    body: { description },
  });
  if (error) throw error;
  return data as GeneratedAgent;
}

// =============================================================
// Utils
// =============================================================
export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'session-' + Math.random().toString(36).slice(2);
}

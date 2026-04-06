// Frontend client for the Email Agent module.
// Tables live in `purama_ai` schema (matches the supabase client default).
import { supabase } from '@/integrations/supabase/client';

// Use the raw client (the generated `Database` type doesn't yet know about
// these tables). We bypass type narrowing with `as any` only at the .from()
// boundary so the rest of the code stays strictly typed.
type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

// =============================================================
// Types
// =============================================================
export type AutonomyLevel = 1 | 2 | 3 | 4 | 5;

export type ToneId =
  | 'professionnel_strict'
  | 'professionnel_amical'
  | 'decontracte'
  | 'custom';

export type EmailAction =
  | 'auto_reply'
  | 'draft'
  | 'notify'
  | 'archive'
  | 'ignore'
  | 'forward'
  | 'label'
  | 'error';

export type EmailCategory =
  | 'urgent'
  | 'important'
  | 'normal'
  | 'spam'
  | 'newsletter'
  | 'promo';

export interface EmailAgentConfig {
  id?: string;
  user_id: string;
  is_active: boolean;
  autonomy_level: AutonomyLevel;
  tone: ToneId;
  custom_tone_prompt: string | null;
  signature: string;
  language: string;
  excluded_emails: string[];
  excluded_domains: string[];
  auto_reply_categories: string[];
  notify_categories: string[];
  archive_categories: string[];
  working_hours_only: boolean;
  working_hours_start: string;
  working_hours_end: string;
  daily_digest: boolean;
  daily_digest_time: string;
  vacation_mode: boolean;
  vacation_message: string | null;
  gmail_email: string | null;
  last_sync_at: string | null;
  total_processed: number;
  total_auto_replied: number;
  total_drafted: number;
  total_notified: number;
  total_archived: number;
  estimated_time_saved_minutes: number;
  created_at?: string;
  updated_at?: string;
}

export interface EmailAgentLog {
  id: string;
  user_id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  gmail_draft_id: string | null;
  from_email: string;
  from_name: string | null;
  to_email: string | null;
  subject: string | null;
  snippet: string | null;
  body_preview: string | null;
  received_at: string | null;
  category: EmailCategory;
  intention: string | null;
  sentiment: string | null;
  urgency_score: number | null;
  tags: string[];
  action_taken: EmailAction;
  ai_response: string | null;
  ai_subject: string | null;
  ai_reasoning: string | null;
  confidence_score: number | null;
  user_approved: boolean | null;
  user_feedback: string | null;
  feedback_at: string | null;
  tokens_used: number | null;
  processing_time_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface EmailAgentRule {
  id: string;
  user_id: string;
  rule_name: string;
  is_active: boolean;
  priority: number;
  condition_from_email: string | null;
  condition_from_domain: string | null;
  condition_subject_contains: string | null;
  condition_body_contains: string | null;
  condition_category: string | null;
  action: EmailAction;
  action_reply_template: string | null;
  action_forward_to: string | null;
  action_label: string | null;
  action_notify_message: string | null;
  match_count: number;
  created_at: string;
  updated_at: string;
}

export interface EmailAgentMemory {
  id: string;
  user_id: string;
  contact_email: string;
  contact_name: string | null;
  relationship: string | null;
  preferred_tone: string | null;
  context_notes: string | null;
  last_interaction: string | null;
  interaction_count: number;
  auto_reply_ok: boolean;
  is_blocked: boolean;
  created_at: string;
  updated_at: string;
}

export interface EmailAgentTemplate {
  id: string;
  user_id: string;
  template_name: string;
  template_category: string | null;
  subject_template: string | null;
  body_template: string;
  variables: string[];
  is_active: boolean;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

// =============================================================
// Static metadata (UI labels, defaults)
// =============================================================
export const AUTONOMY_LEVELS: Record<
  AutonomyLevel,
  { label: string; description: string; emoji: string }
> = {
  1: {
    label: 'Observateur',
    description: 'Notifie tout, ne fait rien automatiquement.',
    emoji: '👀',
  },
  2: {
    label: 'Trieur',
    description: 'Classe + notifie les emails importants.',
    emoji: '🗂️',
  },
  3: {
    label: 'Assistant',
    description: 'Répond aux emails simples, brouillon pour le reste.',
    emoji: '🤝',
  },
  4: {
    label: 'Bras droit',
    description: 'Répond à presque tout, brouillon uniquement pour décisions importantes.',
    emoji: '🚀',
  },
  5: {
    label: 'Pilote auto',
    description: '100% autonome, ne demande l\'approbation que sur du critique.',
    emoji: '🤖',
  },
};

export const TONES: Record<ToneId, { label: string; description: string }> = {
  professionnel_strict: {
    label: 'Professionnel strict',
    description: 'Formel, distancé, parfait pour le B2B.',
  },
  professionnel_amical: {
    label: 'Professionnel amical',
    description: 'Le défaut. Chaleureux mais pro.',
  },
  decontracte: {
    label: 'Décontracté',
    description: 'Tutoiement, ton détendu.',
  },
  custom: {
    label: 'Personnalisé',
    description: 'Définis ton propre style.',
  },
};

export const CATEGORY_META: Record<
  EmailCategory,
  { label: string; emoji: string; color: string }
> = {
  urgent: { label: 'Urgent', emoji: '🚨', color: 'text-red-400' },
  important: { label: 'Important', emoji: '⭐', color: 'text-yellow-400' },
  normal: { label: 'Normal', emoji: '📧', color: 'text-blue-400' },
  newsletter: { label: 'Newsletter', emoji: '📰', color: 'text-purple-400' },
  promo: { label: 'Promo', emoji: '🛍️', color: 'text-pink-400' },
  spam: { label: 'Spam', emoji: '🚫', color: 'text-gray-500' },
};

export const ACTION_META: Record<
  EmailAction,
  { label: string; emoji: string; color: string }
> = {
  auto_reply: { label: 'Réponse auto', emoji: '⚡', color: 'text-emerald-400' },
  draft: { label: 'Brouillon', emoji: '📝', color: 'text-yellow-400' },
  notify: { label: 'Notifié', emoji: '🔔', color: 'text-cyan-400' },
  archive: { label: 'Archivé', emoji: '📦', color: 'text-gray-400' },
  ignore: { label: 'Ignoré', emoji: '➖', color: 'text-gray-500' },
  forward: { label: 'Transféré', emoji: '➡️', color: 'text-indigo-400' },
  label: { label: 'Étiqueté', emoji: '🏷️', color: 'text-violet-400' },
  error: { label: 'Erreur', emoji: '❌', color: 'text-red-500' },
};

const DEFAULT_CONFIG: Omit<EmailAgentConfig, 'user_id'> = {
  is_active: false,
  autonomy_level: 2,
  tone: 'professionnel_amical',
  custom_tone_prompt: null,
  signature: '',
  language: 'fr',
  excluded_emails: [],
  excluded_domains: [],
  auto_reply_categories: ['confirmation', 'remerciement', 'faq'],
  notify_categories: ['urgent', 'important', 'partenariat', 'facturation'],
  archive_categories: ['newsletter', 'spam', 'promo'],
  working_hours_only: false,
  working_hours_start: '08:00',
  working_hours_end: '19:00',
  daily_digest: true,
  daily_digest_time: '08:00',
  vacation_mode: false,
  vacation_message: null,
  gmail_email: null,
  last_sync_at: null,
  total_processed: 0,
  total_auto_replied: 0,
  total_drafted: 0,
  total_notified: 0,
  total_archived: 0,
  estimated_time_saved_minutes: 0,
};

// =============================================================
// CONFIG
// =============================================================
export async function getConfig(userId: string): Promise<EmailAgentConfig> {
  const { data, error } = await sb()
    .from('email_agent_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as EmailAgentConfig;
  // Auto-create defaults on first read so the UI never has to handle null.
  const insertPayload = { ...DEFAULT_CONFIG, user_id: userId };
  const { data: inserted, error: insertErr } = await sb()
    .from('email_agent_config')
    .insert(insertPayload)
    .select()
    .single();
  if (insertErr) throw insertErr;
  return inserted as EmailAgentConfig;
}

export async function updateConfig(
  userId: string,
  patch: Partial<EmailAgentConfig>,
): Promise<EmailAgentConfig> {
  const { data, error } = await sb()
    .from('email_agent_config')
    .update(patch)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentConfig;
}

// =============================================================
// LOGS
// =============================================================
export async function listLogs(
  userId: string,
  opts: {
    limit?: number;
    action?: EmailAction;
    category?: EmailCategory;
    pendingOnly?: boolean;
  } = {},
): Promise<EmailAgentLog[]> {
  let q = sb()
    .from('email_agent_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 50);
  if (opts.action) q = q.eq('action_taken', opts.action);
  if (opts.category) q = q.eq('category', opts.category);
  if (opts.pendingOnly) q = q.is('user_approved', null).eq('action_taken', 'draft');
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as EmailAgentLog[];
}

export async function approveLog(
  logId: string,
  feedback?: string,
): Promise<void> {
  const { error } = await sb()
    .from('email_agent_logs')
    .update({
      user_approved: true,
      user_feedback: feedback ?? null,
      feedback_at: new Date().toISOString(),
    })
    .eq('id', logId);
  if (error) throw error;
}

export async function rejectLog(
  logId: string,
  feedback?: string,
): Promise<void> {
  const { error } = await sb()
    .from('email_agent_logs')
    .update({
      user_approved: false,
      user_feedback: feedback ?? null,
      feedback_at: new Date().toISOString(),
    })
    .eq('id', logId);
  if (error) throw error;
}

export async function pendingDraftsCount(userId: string): Promise<number> {
  const { count, error } = await sb()
    .from('email_agent_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('action_taken', 'draft')
    .is('user_approved', null);
  if (error) throw error;
  return count ?? 0;
}

// =============================================================
// RULES
// =============================================================
export async function listRules(userId: string): Promise<EmailAgentRule[]> {
  const { data, error } = await sb()
    .from('email_agent_rules')
    .select('*')
    .eq('user_id', userId)
    .order('priority', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmailAgentRule[];
}

export async function createRule(
  userId: string,
  rule: Partial<EmailAgentRule>,
): Promise<EmailAgentRule> {
  const { data, error } = await sb()
    .from('email_agent_rules')
    .insert({ ...rule, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentRule;
}

export async function updateRule(
  id: string,
  patch: Partial<EmailAgentRule>,
): Promise<EmailAgentRule> {
  const { data, error } = await sb()
    .from('email_agent_rules')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentRule;
}

export async function deleteRule(id: string): Promise<void> {
  const { error } = await sb().from('email_agent_rules').delete().eq('id', id);
  if (error) throw error;
}

// =============================================================
// MEMORY
// =============================================================
export async function listMemory(userId: string): Promise<EmailAgentMemory[]> {
  const { data, error } = await sb()
    .from('email_agent_memory')
    .select('*')
    .eq('user_id', userId)
    .order('last_interaction', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as EmailAgentMemory[];
}

export async function updateMemory(
  id: string,
  patch: Partial<EmailAgentMemory>,
): Promise<EmailAgentMemory> {
  const { data, error } = await sb()
    .from('email_agent_memory')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentMemory;
}

export async function deleteMemory(id: string): Promise<void> {
  const { error } = await sb().from('email_agent_memory').delete().eq('id', id);
  if (error) throw error;
}

// =============================================================
// TEMPLATES
// =============================================================
export async function listTemplates(
  userId: string,
): Promise<EmailAgentTemplate[]> {
  const { data, error } = await sb()
    .from('email_agent_templates')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EmailAgentTemplate[];
}

export async function createTemplate(
  userId: string,
  tpl: Partial<EmailAgentTemplate>,
): Promise<EmailAgentTemplate> {
  const { data, error } = await sb()
    .from('email_agent_templates')
    .insert({ ...tpl, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentTemplate;
}

export async function updateTemplate(
  id: string,
  patch: Partial<EmailAgentTemplate>,
): Promise<EmailAgentTemplate> {
  const { data, error } = await sb()
    .from('email_agent_templates')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as EmailAgentTemplate;
}

export async function deleteTemplate(id: string): Promise<void> {
  const { error } = await sb()
    .from('email_agent_templates')
    .delete()
    .eq('id', id);
  if (error) throw error;
}

// =============================================================
// Gmail OAuth (delegated to edge function)
// =============================================================
export async function getGmailOAuthUrl(): Promise<string> {
  const { data, error } = await supabase.functions.invoke(
    'email-agent-gmail-oauth',
    { body: { action: 'start' } },
  );
  if (error) throw error;
  const url = (data as { url?: string } | null)?.url;
  if (!url) throw new Error('Aucune URL OAuth retournée');
  return url;
}

export async function disconnectGmail(userId: string): Promise<void> {
  await updateConfig(userId, {
    gmail_email: null,
    is_active: false,
  });
}

// =============================================================
// Approve a draft → tells n8n to actually send it
// =============================================================
export async function sendDraft(logId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('email-agent-send-draft', {
    body: { log_id: logId },
  });
  if (error) throw error;
}

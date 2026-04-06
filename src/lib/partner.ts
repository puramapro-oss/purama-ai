// Frontend client for the Partner Agent module.
// All tables live in the `purama_ai` schema (default of the supabase client).
import { supabase } from '@/integrations/supabase/client';

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

// =============================================================
// Types
// =============================================================
export type ProspectStatus =
  | 'identified' | 'ready_to_contact' | 'contacted'
  | 'relance_1' | 'relance_2' | 'relance_3'
  | 'interested' | 'contract_sent' | 'contract_signed'
  | 'active' | 'inactive' | 'rejected';

export type ProspectType =
  | 'influencer' | 'website' | 'association' | 'media' | 'commerce' | 'other';

export type EmailType =
  | 'outreach' | 'relance_1' | 'relance_2' | 'relance_3'
  | 'contract' | 'welcome' | 'custom' | 'reply';

export type PartnerLevel =
  | 'starter' | 'silver' | 'gold' | 'platinum' | 'diamond' | 'titan' | 'eternal';

export interface PartnerConfig {
  id?: string;
  user_id: string;
  is_active: boolean;
  sender_name: string | null;
  sender_email: string | null;
  sender_title: string | null;
  company_name: string;
  signature_image_url: string | null;
  signature_name: string | null;
  signature_title: string | null;
  daily_outreach_limit: number;
  outreach_hours_start: string;
  outreach_hours_end: string;
  outreach_days: string[];
  relance_1_delay_days: number;
  relance_2_delay_days: number;
  relance_3_delay_days: number;
  max_relances: number;
  commission_first_payment: number;
  commission_recurring: number;
  contract_template_id: string | null;
  contract_pdf_url: string | null;
  auto_send_contract: boolean;
  target_niches: string[];
  target_min_followers: number;
  target_countries: string[];
  target_languages: string[];
  outreach_tone: string;
  custom_tone_prompt: string | null;
  require_approval_new_prospect: boolean;
  require_approval_outreach: boolean;
  require_approval_contract: boolean;
  total_prospects_found: number;
  total_emails_sent: number;
  total_replies: number;
  total_active_partners: number;
  total_revenue_generated: number;
  created_at?: string;
  updated_at?: string;
}

export interface PartnerProspect {
  id: string;
  user_id: string;
  name: string;
  email: string | null;
  website: string | null;
  social_links: Record<string, string>;
  type: ProspectType | null;
  niche: string | null;
  followers_count: number | null;
  monthly_visitors: number | null;
  engagement_rate: number | null;
  audience_country: string | null;
  status: ProspectStatus;
  first_contact_at: string | null;
  last_contact_at: string | null;
  relance_count: number;
  next_action_at: string | null;
  has_replied: boolean;
  reply_sentiment: string | null;
  reply_summary: string | null;
  contract_sent_at: string | null;
  contract_signed_at: string | null;
  contract_url: string | null;
  ai_score: number | null;
  ai_reasoning: string | null;
  notes: string | null;
  tags: string[];
  source: string | null;
  found_by_ai: boolean;
  created_at: string;
  updated_at: string;
}

export interface PartnerEmail {
  id: string;
  user_id: string;
  prospect_id: string;
  type: EmailType;
  subject: string;
  body_html: string;
  body_text: string | null;
  sent_at: string | null;
  delivered: boolean | null;
  opened: boolean;
  opened_at: string | null;
  clicked: boolean;
  clicked_at: string | null;
  replied: boolean;
  replied_at: string | null;
  bounced: boolean;
  resend_message_id: string | null;
  status: 'draft' | 'pending_approval' | 'approved' | 'sent' | 'failed';
  approved_at: string | null;
  created_at: string;
}

export interface PartnerActive {
  id: string;
  user_id: string;
  prospect_id: string | null;
  partner_name: string;
  partner_email: string;
  referral_code: string;
  referral_link: string;
  total_clicks: number;
  total_signups: number;
  total_conversions: number;
  total_revenue_generated: number;
  total_commission_earned: number;
  total_commission_paid: number;
  level: PartnerLevel;
  equity_granted: boolean;
  hereditary_commissions: boolean;
  tesla_reward: boolean;
  is_active: boolean;
  joined_at: string;
  last_activity_at: string | null;
  created_at: string;
}

export interface PartnerCommission {
  id: string;
  user_id: string;
  partner_id: string;
  type: 'first_payment' | 'recurring' | 'bonus';
  amount: number;
  percentage: number;
  source_payment_id: string | null;
  source_customer_email: string | null;
  source_app: string | null;
  status: 'pending' | 'approved' | 'paid' | 'cancelled';
  paid_at: string | null;
  payment_method: string | null;
  created_at: string;
}

// =============================================================
// Static metadata
// =============================================================
export const STATUS_META: Record<
  ProspectStatus,
  { label: string; emoji: string; color: string; column: string }
> = {
  identified: { label: 'Identifié', emoji: '🔍', color: 'text-muted-foreground', column: 'identified' },
  ready_to_contact: { label: 'Prêt à contacter', emoji: '📋', color: 'text-cyan-400', column: 'identified' },
  contacted: { label: 'Contacté', emoji: '✉️', color: 'text-cyan-400', column: 'contacted' },
  relance_1: { label: 'Relance 1', emoji: '🔁', color: 'text-yellow-400', column: 'contacted' },
  relance_2: { label: 'Relance 2', emoji: '🔁', color: 'text-yellow-400', column: 'contacted' },
  relance_3: { label: 'Relance 3', emoji: '🔁', color: 'text-orange-400', column: 'contacted' },
  interested: { label: 'Intéressé', emoji: '🔥', color: 'text-emerald-400', column: 'interested' },
  contract_sent: { label: 'Contrat envoyé', emoji: '📝', color: 'text-purple-400', column: 'contract' },
  contract_signed: { label: 'Contrat signé', emoji: '✍️', color: 'text-emerald-400', column: 'contract' },
  active: { label: 'Actif', emoji: '🚀', color: 'text-emerald-500', column: 'active' },
  inactive: { label: 'Inactif', emoji: '💤', color: 'text-gray-500', column: 'active' },
  rejected: { label: 'Rejeté', emoji: '❌', color: 'text-red-400', column: 'rejected' },
};

export const PIPELINE_COLUMNS: { id: string; label: string; statuses: ProspectStatus[] }[] = [
  { id: 'identified', label: 'Identifiés', statuses: ['identified', 'ready_to_contact'] },
  { id: 'contacted', label: 'Contactés', statuses: ['contacted', 'relance_1', 'relance_2', 'relance_3'] },
  { id: 'interested', label: 'Intéressés', statuses: ['interested'] },
  { id: 'contract', label: 'Contrats', statuses: ['contract_sent', 'contract_signed'] },
  { id: 'active', label: 'Actifs', statuses: ['active'] },
];

export const PROSPECT_TYPES: { value: ProspectType; label: string; emoji: string }[] = [
  { value: 'influencer', label: 'Influenceur', emoji: '⭐' },
  { value: 'website', label: 'Site / blog', emoji: '🌐' },
  { value: 'association', label: 'Association', emoji: '🤝' },
  { value: 'media', label: 'Média', emoji: '📰' },
  { value: 'commerce', label: 'Commerce', emoji: '🏪' },
  { value: 'other', label: 'Autre', emoji: '📦' },
];

export const TONES = [
  { value: 'professionnel_strict', label: 'Professionnel strict' },
  { value: 'professionnel_enthousiaste', label: 'Professionnel enthousiaste' },
  { value: 'amical', label: 'Amical' },
  { value: 'percutant', label: 'Percutant / direct' },
  { value: 'custom', label: 'Personnalisé' },
];

export const NICHES = [
  'fitness', 'finance', 'tech', 'crypto', 'écologie', 'juridique',
  'santé', 'éducation', 'food', 'voyage', 'mode', 'beauté',
  'parentalité', 'développement perso', 'business', 'marketing',
  'gaming', 'musique', 'art', 'sport',
];

export const PARTNER_LEVELS: Record<
  PartnerLevel,
  { label: string; min: number; reward: string; emoji: string }
> = {
  starter: { label: 'Starter', min: 0, reward: 'Pack visuels + coach IA', emoji: '🌱' },
  silver: { label: 'Argent', min: 50, reward: 'Mug Purama + bonus 5%', emoji: '🥈' },
  gold: { label: 'Or', min: 150, reward: 'Sweat + bonus 10%', emoji: '🥇' },
  platinum: { label: 'Platine', min: 250, reward: 'AirPods + equity 1%', emoji: '💎' },
  diamond: { label: 'Diamant', min: 500, reward: 'iPad + equity 5% + héritage', emoji: '🔷' },
  titan: { label: 'Titan', min: 1000, reward: 'Tesla', emoji: '🚗' },
  eternal: { label: 'Éternel', min: 5000, reward: '1% Purama à vie', emoji: '♾️' },
};

const DEFAULT_CONFIG: Omit<PartnerConfig, 'user_id'> = {
  is_active: false,
  sender_name: null,
  sender_email: null,
  sender_title: null,
  company_name: 'Purama',
  signature_image_url: null,
  signature_name: null,
  signature_title: null,
  daily_outreach_limit: 20,
  outreach_hours_start: '09:00',
  outreach_hours_end: '18:00',
  outreach_days: ['MO', 'TU', 'WE', 'TH', 'FR'],
  relance_1_delay_days: 3,
  relance_2_delay_days: 7,
  relance_3_delay_days: 14,
  max_relances: 3,
  commission_first_payment: 50,
  commission_recurring: 10,
  contract_template_id: null,
  contract_pdf_url: null,
  auto_send_contract: true,
  target_niches: [],
  target_min_followers: 1000,
  target_countries: ['FR'],
  target_languages: ['fr'],
  outreach_tone: 'professionnel_enthousiaste',
  custom_tone_prompt: null,
  require_approval_new_prospect: false,
  require_approval_outreach: false,
  require_approval_contract: true,
  total_prospects_found: 0,
  total_emails_sent: 0,
  total_replies: 0,
  total_active_partners: 0,
  total_revenue_generated: 0,
};

// =============================================================
// CONFIG
// =============================================================
export async function getPartnerConfig(userId: string): Promise<PartnerConfig> {
  const { data, error } = await sb()
    .from('partner_agent_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as PartnerConfig;
  const insertPayload = { ...DEFAULT_CONFIG, user_id: userId };
  const { data: inserted, error: insertErr } = await sb()
    .from('partner_agent_config')
    .insert(insertPayload)
    .select()
    .single();
  if (insertErr) throw insertErr;
  return inserted as PartnerConfig;
}

export async function updatePartnerConfig(
  userId: string,
  patch: Partial<PartnerConfig>,
): Promise<PartnerConfig> {
  const { data, error } = await sb()
    .from('partner_agent_config')
    .update(patch)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as PartnerConfig;
}

// =============================================================
// PROSPECTS
// =============================================================
export async function listProspects(
  userId: string,
  opts: { status?: ProspectStatus; type?: ProspectType; limit?: number } = {},
): Promise<PartnerProspect[]> {
  let q = sb()
    .from('partner_prospects')
    .select('*')
    .eq('user_id', userId)
    .order('ai_score', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(opts.limit ?? 200);
  if (opts.status) q = q.eq('status', opts.status);
  if (opts.type) q = q.eq('type', opts.type);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PartnerProspect[];
}

export async function createProspect(
  userId: string,
  prospect: Partial<PartnerProspect>,
): Promise<PartnerProspect> {
  const { data, error } = await sb()
    .from('partner_prospects')
    .insert({ ...prospect, user_id: userId, source: prospect.source ?? 'manual' })
    .select()
    .single();
  if (error) throw error;
  return data as PartnerProspect;
}

export async function updateProspect(
  id: string,
  patch: Partial<PartnerProspect>,
): Promise<PartnerProspect> {
  const { data, error } = await sb()
    .from('partner_prospects')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as PartnerProspect;
}

export async function deleteProspect(id: string): Promise<void> {
  const { error } = await sb().from('partner_prospects').delete().eq('id', id);
  if (error) throw error;
}

// =============================================================
// PROSPECT FINDER (delegated to edge function — Tavily + Claude)
// =============================================================
export async function findProspects(
  query: string,
  niche?: string,
  type?: ProspectType,
): Promise<{ inserted: number; prospects: PartnerProspect[] }> {
  const { data, error } = await supabase.functions.invoke('partner-find-prospects', {
    body: { query, niche, type },
  });
  if (error) throw error;
  return data as { inserted: number; prospects: PartnerProspect[] };
}

// =============================================================
// SEND outreach email (delegated to edge function — Claude + Resend)
// =============================================================
export async function sendOutreach(prospectId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('partner-send-outreach', {
    body: { prospect_id: prospectId },
  });
  if (error) throw error;
}

// =============================================================
// EMAILS
// =============================================================
export async function listEmails(
  userId: string,
  prospectId?: string,
  limit = 100,
): Promise<PartnerEmail[]> {
  let q = sb()
    .from('partner_emails')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (prospectId) q = q.eq('prospect_id', prospectId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PartnerEmail[];
}

// =============================================================
// PARTNERS (active)
// =============================================================
export async function listActivePartners(
  userId: string,
): Promise<PartnerActive[]> {
  const { data, error } = await sb()
    .from('partner_active')
    .select('*')
    .eq('user_id', userId)
    .order('total_revenue_generated', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PartnerActive[];
}

// =============================================================
// COMMISSIONS
// =============================================================
export async function listCommissions(
  userId: string,
  status?: PartnerCommission['status'],
): Promise<PartnerCommission[]> {
  let q = sb()
    .from('partner_commissions')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as PartnerCommission[];
}

export async function partnerStats(userId: string): Promise<{
  prospectsTotal: number;
  prospectsContacted: number;
  prospectsInterested: number;
  partnersActive: number;
  emailsSent: number;
  emailsReplied: number;
  pendingCommissions: number;
  totalRevenueGenerated: number;
}> {
  const [prospects, emails, partners, commissions] = await Promise.all([
    sb().from('partner_prospects').select('status', { count: 'exact' }).eq('user_id', userId),
    sb().from('partner_emails').select('replied,sent_at', { count: 'exact' }).eq('user_id', userId).not('sent_at', 'is', null),
    sb().from('partner_active').select('total_revenue_generated', { count: 'exact' }).eq('user_id', userId).eq('is_active', true),
    sb().from('partner_commissions').select('amount,status', { count: 'exact' }).eq('user_id', userId),
  ]);
  // deno-lint-ignore no-explicit-any
  const prosRows = (prospects.data ?? []) as Array<{ status: string }>;
  // deno-lint-ignore no-explicit-any
  const emailRows = (emails.data ?? []) as Array<{ replied: boolean }>;
  // deno-lint-ignore no-explicit-any
  const partnerRows = (partners.data ?? []) as Array<{ total_revenue_generated: number }>;
  // deno-lint-ignore no-explicit-any
  const commRows = (commissions.data ?? []) as Array<{ amount: number; status: string }>;

  return {
    prospectsTotal: prosRows.length,
    prospectsContacted: prosRows.filter(p => ['contacted', 'relance_1', 'relance_2', 'relance_3'].includes(p.status)).length,
    prospectsInterested: prosRows.filter(p => p.status === 'interested').length,
    partnersActive: partnerRows.length,
    emailsSent: emailRows.length,
    emailsReplied: emailRows.filter(e => e.replied).length,
    pendingCommissions: commRows.filter(c => c.status === 'pending').reduce((s, c) => s + Number(c.amount), 0),
    totalRevenueGenerated: partnerRows.reduce((s, p) => s + Number(p.total_revenue_generated), 0),
  };
}

// =============================================================
// TEMPLATES
// =============================================================
export async function listEmailTemplates(userId: string) {
  const { data, error } = await sb()
    .from('partner_email_templates')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// =============================================================
// SIGNATURE upload
// =============================================================
export async function uploadSignature(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'png';
  const path = `${userId}/signature.${ext}`;
  // Use the supabase storage client directly via the typed namespace
  // (works through the same client, ignores the schema setting)
  const { error } = await supabase.storage
    .from('partner-signatures')
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  const { data: signed, error: signErr } = await supabase.storage
    .from('partner-signatures')
    .createSignedUrl(path, 60 * 60 * 24 * 365);
  if (signErr || !signed?.signedUrl) throw signErr ?? new Error('No signed URL');
  await updatePartnerConfig(userId, { signature_image_url: signed.signedUrl });
  return signed.signedUrl;
}

// =============================================================
// Utils
// =============================================================
export function formatEUR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(n);
}

export function levelFromConversions(n: number): PartnerLevel {
  if (n >= 5000) return 'eternal';
  if (n >= 1000) return 'titan';
  if (n >= 500) return 'diamond';
  if (n >= 250) return 'platinum';
  if (n >= 150) return 'gold';
  if (n >= 50) return 'silver';
  return 'starter';
}

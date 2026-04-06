// Frontend client for the Compta Agent module.
// Tables live in `purama_ai` schema (default of the supabase client).
import { supabase } from '@/integrations/supabase/client';

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

// =============================================================
// Types
// =============================================================
export type LegalForm =
  | 'SASU' | 'SAS' | 'EURL' | 'SARL' | 'EI' | 'auto-entrepreneur' | 'autre';

export type FiscalRegime = 'reel_normal' | 'reel_simplifie' | 'micro';
export type TvaRegime = 'mensuel' | 'trimestriel' | 'annuel' | 'franchise';
export type DeclarationType =
  | 'tva_ca3' | 'tva_ca12' | 'is' | 'liasse' | 'cfe' | 'cvae' | 'das2';
export type DeclarationStatus =
  | 'calculating' | 'ready' | 'pending_approval' | 'approved'
  | 'sending' | 'sent' | 'confirmed' | 'error' | 'rejected';
export type InvoiceType = 'emise' | 'recue';
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue' | 'cancelled';

export interface ComptaConfig {
  id?: string;
  user_id: string;
  is_active: boolean;
  company_name: string | null;
  siren: string | null;
  siret: string | null;
  naf_code: string | null;
  legal_form: LegalForm | null;
  fiscal_regime: FiscalRegime | null;
  tva_regime: TvaRegime | null;
  tva_number: string | null;
  fiscal_year_start: number;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
  is_zfrr: boolean;
  zfrr_start_date: string | null;
  is_zfu: boolean;
  is_bassins_emploi: boolean;
  cir_eligible: boolean;
  cii_eligible: boolean;
  ip_box_eligible: boolean;
  jei_status: boolean;
  bridge_user_uuid: string | null;
  bridge_accounts: BridgeAccount[];
  bridge_last_sync_at: string | null;
  auto_categorize: boolean;
  auto_tva: boolean;
  auto_declarations: boolean;
  require_approval_before_send: boolean;
  notify_new_transaction: boolean;
  notify_declaration_ready: boolean;
  notify_anomaly: boolean;
  notify_monthly_report: boolean;
  edi_partner_id: string | null;
  edi_enabled: boolean;
  invoice_prefix: string;
  invoice_next_number: number;
  total_transactions: number;
  total_invoices: number;
  total_declarations: number;
  fiscal_health_score: number;
  created_at?: string;
  updated_at?: string;
}

export interface BridgeAccount {
  id: string;
  name: string;
  iban?: string;
  type?: string;
  balance?: number;
}

export interface ComptaTransaction {
  id: string;
  user_id: string;
  bridge_transaction_id: string | null;
  bridge_account_id: string | null;
  date: string;
  description: string;
  raw_description: string | null;
  amount: number;
  currency: string;
  type: 'debit' | 'credit' | null;
  category: string | null;
  subcategory: string | null;
  pcg_account: string | null;
  pcg_label: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  user_validated: boolean;
  user_category_override: string | null;
  tva_rate: number | null;
  tva_amount: number | null;
  ht_amount: number | null;
  tva_deductible: boolean;
  receipt_url: string | null;
  receipt_matched: boolean;
  invoice_id: string | null;
  is_cca: boolean;
  is_ik: boolean;
  is_amortizable: boolean;
  amortization_duration_months: number | null;
  amortization_start_date: string | null;
  is_recurring: boolean;
  is_anomaly: boolean;
  counterpart_name: string | null;
  counterpart_siren: string | null;
  tags: string[];
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unit_price: number;
  tva_rate: number;
  total_ht: number;
}

export interface ComptaInvoice {
  id: string;
  user_id: string;
  invoice_number: string;
  type: InvoiceType;
  status: InvoiceStatus;
  counterpart_name: string;
  counterpart_siren: string | null;
  counterpart_tva_number: string | null;
  counterpart_address: string | null;
  counterpart_email: string | null;
  total_ht: number;
  total_tva: number;
  total_ttc: number;
  lines: InvoiceLine[];
  issue_date: string;
  due_date: string | null;
  payment_date: string | null;
  facturx_pdf_url: string | null;
  facturx_xml: string | null;
  facturx_profile: string;
  payment_method: string | null;
  matched_transaction_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComptaDeclaration {
  id: string;
  user_id: string;
  type: DeclarationType;
  period: string;
  status: DeclarationStatus;
  calculated_data: Record<string, unknown>;
  pdf_url: string | null;
  edi_file_url: string | null;
  notification_sent_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  rejection_reason: string | null;
  sent_at: string | null;
  sent_via: string | null;
  confirmation_number: string | null;
  deadline: string;
  ai_notes: string | null;
  ai_optimizations: string[];
  created_at: string;
  updated_at: string;
}

export interface AgentNotification {
  id: string;
  user_id: string;
  agent_type: string;
  title: string;
  body: string;
  action_type: string | null;
  action_payload: Record<string, unknown> | null;
  action_url: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  is_read: boolean;
  is_actioned: boolean;
  created_at: string;
}

// =============================================================
// Static metadata
// =============================================================
export const LEGAL_FORMS: { value: LegalForm; label: string }[] = [
  { value: 'SASU', label: 'SASU' },
  { value: 'SAS', label: 'SAS' },
  { value: 'EURL', label: 'EURL' },
  { value: 'SARL', label: 'SARL' },
  { value: 'EI', label: 'Entreprise Individuelle' },
  { value: 'auto-entrepreneur', label: 'Auto-entrepreneur' },
  { value: 'autre', label: 'Autre' },
];

export const FISCAL_REGIMES: { value: FiscalRegime; label: string }[] = [
  { value: 'reel_normal', label: 'Réel normal' },
  { value: 'reel_simplifie', label: 'Réel simplifié' },
  { value: 'micro', label: 'Micro' },
];

export const TVA_REGIMES: { value: TvaRegime; label: string }[] = [
  { value: 'mensuel', label: 'Mensuel (CA3)' },
  { value: 'trimestriel', label: 'Trimestriel (CA3)' },
  { value: 'annuel', label: 'Annuel (CA12)' },
  { value: 'franchise', label: 'Franchise en base (art. 293B)' },
];

export const DECLARATION_META: Record<
  DeclarationType,
  { label: string; emoji: string; color: string }
> = {
  tva_ca3: { label: 'TVA CA3', emoji: '📊', color: 'text-accent-cyan' },
  tva_ca12: { label: 'TVA CA12', emoji: '📊', color: 'text-accent-cyan' },
  is: { label: 'Impôt Sociétés', emoji: '🏦', color: 'text-accent-purple' },
  liasse: { label: 'Liasse fiscale', emoji: '📚', color: 'text-emerald-400' },
  cfe: { label: 'CFE', emoji: '🏢', color: 'text-yellow-400' },
  cvae: { label: 'CVAE', emoji: '🏭', color: 'text-orange-400' },
  das2: { label: 'DAS2', emoji: '👥', color: 'text-pink-400' },
};

export const STATUS_META: Record<
  DeclarationStatus,
  { label: string; color: string }
> = {
  calculating: { label: 'Calcul en cours…', color: 'text-muted-foreground' },
  ready: { label: 'Prête', color: 'text-yellow-400' },
  pending_approval: { label: 'À valider', color: 'text-yellow-400' },
  approved: { label: 'Approuvée', color: 'text-emerald-400' },
  sending: { label: 'Envoi…', color: 'text-cyan-400' },
  sent: { label: 'Envoyée', color: 'text-emerald-400' },
  confirmed: { label: 'Confirmée DGFiP', color: 'text-emerald-500' },
  error: { label: 'Erreur', color: 'text-red-400' },
  rejected: { label: 'Rejetée', color: 'text-red-400' },
};

const DEFAULT_CONFIG: Omit<ComptaConfig, 'user_id'> = {
  is_active: false,
  company_name: null,
  siren: null,
  siret: null,
  naf_code: null,
  legal_form: 'SASU',
  fiscal_regime: 'reel_normal',
  tva_regime: 'trimestriel',
  tva_number: null,
  fiscal_year_start: 1,
  address: null,
  postal_code: null,
  city: null,
  country: 'FR',
  is_zfrr: false,
  zfrr_start_date: null,
  is_zfu: false,
  is_bassins_emploi: false,
  cir_eligible: false,
  cii_eligible: false,
  ip_box_eligible: false,
  jei_status: false,
  bridge_user_uuid: null,
  bridge_accounts: [],
  bridge_last_sync_at: null,
  auto_categorize: true,
  auto_tva: true,
  auto_declarations: true,
  require_approval_before_send: true,
  notify_new_transaction: false,
  notify_declaration_ready: true,
  notify_anomaly: true,
  notify_monthly_report: true,
  edi_partner_id: null,
  edi_enabled: false,
  invoice_prefix: 'FA',
  invoice_next_number: 1,
  total_transactions: 0,
  total_invoices: 0,
  total_declarations: 0,
  fiscal_health_score: 50,
};

// =============================================================
// CONFIG
// =============================================================
export async function getComptaConfig(userId: string): Promise<ComptaConfig> {
  const { data, error } = await sb()
    .from('compta_agent_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as ComptaConfig;
  const insertPayload = { ...DEFAULT_CONFIG, user_id: userId };
  const { data: inserted, error: insertErr } = await sb()
    .from('compta_agent_config')
    .insert(insertPayload)
    .select()
    .single();
  if (insertErr) throw insertErr;
  return inserted as ComptaConfig;
}

export async function updateComptaConfig(
  userId: string,
  patch: Partial<ComptaConfig>,
): Promise<ComptaConfig> {
  const { data, error } = await sb()
    .from('compta_agent_config')
    .update(patch)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as ComptaConfig;
}

// =============================================================
// TRANSACTIONS
// =============================================================
export async function listTransactions(
  userId: string,
  opts: { limit?: number; from?: string; to?: string; category?: string } = {},
): Promise<ComptaTransaction[]> {
  let q = sb()
    .from('compta_transactions')
    .select('*')
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.from) q = q.gte('date', opts.from);
  if (opts.to) q = q.lte('date', opts.to);
  if (opts.category) q = q.eq('category', opts.category);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ComptaTransaction[];
}

export async function updateTransaction(
  id: string,
  patch: Partial<ComptaTransaction>,
): Promise<ComptaTransaction> {
  const { data, error } = await sb()
    .from('compta_transactions')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as ComptaTransaction;
}

export async function transactionStats(userId: string): Promise<{
  monthRevenue: number;
  monthExpense: number;
  monthTvaCollectee: number;
  monthTvaDeductible: number;
  pendingCategorization: number;
  anomalies: number;
}> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const startStr = start.toISOString().slice(0, 10);

  const { data, error } = await sb()
    .from('compta_transactions')
    .select('amount, type, tva_amount, ai_confidence, is_anomaly')
    .eq('user_id', userId)
    .gte('date', startStr);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    amount: number;
    type: string | null;
    tva_amount: number | null;
    ai_confidence: number | null;
    is_anomaly: boolean | null;
  }>;
  let revenue = 0, expense = 0, tvaC = 0, tvaD = 0, pending = 0, anomalies = 0;
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    if (r.type === 'credit' || amt > 0) {
      revenue += Math.abs(amt);
      tvaC += Number(r.tva_amount ?? 0);
    } else {
      expense += Math.abs(amt);
      tvaD += Number(r.tva_amount ?? 0);
    }
    if ((r.ai_confidence ?? 0) < 0.6) pending++;
    if (r.is_anomaly) anomalies++;
  }
  return {
    monthRevenue: revenue,
    monthExpense: expense,
    monthTvaCollectee: tvaC,
    monthTvaDeductible: tvaD,
    pendingCategorization: pending,
    anomalies,
  };
}

// =============================================================
// INVOICES
// =============================================================
export async function listInvoices(
  userId: string,
  opts: { type?: InvoiceType; status?: InvoiceStatus; limit?: number } = {},
): Promise<ComptaInvoice[]> {
  let q = sb()
    .from('compta_invoices')
    .select('*')
    .eq('user_id', userId)
    .order('issue_date', { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.type) q = q.eq('type', opts.type);
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as ComptaInvoice[];
}

export async function createInvoice(
  userId: string,
  invoice: Omit<Partial<ComptaInvoice>, 'id' | 'user_id'>,
): Promise<ComptaInvoice> {
  // Auto-generate invoice number based on the user's prefix + counter
  const cfg = await getComptaConfig(userId);
  const num = `${cfg.invoice_prefix}-${new Date().getFullYear()}-${String(cfg.invoice_next_number).padStart(5, '0')}`;
  await updateComptaConfig(userId, { invoice_next_number: cfg.invoice_next_number + 1 });
  const { data, error } = await sb()
    .from('compta_invoices')
    .insert({
      user_id: userId,
      invoice_number: num,
      ...invoice,
    })
    .select()
    .single();
  if (error) throw error;
  return data as ComptaInvoice;
}

export async function updateInvoice(
  id: string,
  patch: Partial<ComptaInvoice>,
): Promise<ComptaInvoice> {
  const { data, error } = await sb()
    .from('compta_invoices')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as ComptaInvoice;
}

export async function deleteInvoice(id: string): Promise<void> {
  const { error } = await sb().from('compta_invoices').delete().eq('id', id);
  if (error) throw error;
}

// Helper: compute totals from lines + tva rates
export function computeInvoiceTotals(lines: InvoiceLine[]): {
  total_ht: number;
  total_tva: number;
  total_ttc: number;
} {
  let ht = 0, tva = 0;
  for (const l of lines) {
    const lineHt = Number(l.quantity) * Number(l.unit_price);
    const lineTva = lineHt * (Number(l.tva_rate) / 100);
    ht += lineHt;
    tva += lineTva;
  }
  return {
    total_ht: round2(ht),
    total_tva: round2(tva),
    total_ttc: round2(ht + tva),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// =============================================================
// DECLARATIONS
// =============================================================
export async function listDeclarations(
  userId: string,
): Promise<ComptaDeclaration[]> {
  const { data, error } = await sb()
    .from('compta_declarations')
    .select('*')
    .eq('user_id', userId)
    .order('deadline', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ComptaDeclaration[];
}

export async function approveDeclaration(id: string): Promise<void> {
  const { error } = await sb()
    .from('compta_declarations')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: 'user',
    })
    .eq('id', id);
  if (error) throw error;
}

export async function rejectDeclaration(
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await sb()
    .from('compta_declarations')
    .update({
      status: 'rejected',
      rejection_reason: reason,
    })
    .eq('id', id);
  if (error) throw error;
}

export async function pendingDeclarationsCount(userId: string): Promise<number> {
  const { count, error } = await sb()
    .from('compta_declarations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('status', ['ready', 'pending_approval']);
  if (error) throw error;
  return count ?? 0;
}

// =============================================================
// NOTIFICATIONS
// =============================================================
export async function listNotifications(
  userId: string,
  limit = 50,
): Promise<AgentNotification[]> {
  const { data, error } = await sb()
    .from('agent_notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as AgentNotification[];
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await sb()
    .from('agent_notifications')
    .update({ is_read: true })
    .eq('id', id);
  if (error) throw error;
}

export async function unreadNotificationsCount(userId: string): Promise<number> {
  const { count, error } = await sb()
    .from('agent_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
}

// =============================================================
// PUSH (PWA)
// =============================================================
export const VAPID_PUBLIC_KEY =
  (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

export async function subscribeToPush(userId: string): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }
  if (!VAPID_PUBLIC_KEY) {
    console.warn('[push] VAPID public key missing');
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });
  const subJson = sub.toJSON();
  await sb()
    .from('push_subscriptions')
    .upsert(
      {
        user_id: userId,
        subscription: subJson,
        device_info: navigator.userAgent,
        is_active: true,
      },
      { onConflict: 'user_id,endpoint' },
    );
  return true;
}

export async function unsubscribeFromPush(userId: string): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
    await sb()
      .from('push_subscriptions')
      .update({ is_active: false })
      .eq('user_id', userId)
      .eq('endpoint', sub.endpoint);
  }
}

export async function isPushSubscribed(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch {
    return false;
  }
}

// =============================================================
// Bridge OAuth (delegated to edge function)
// =============================================================
export async function getBridgeConnectUrl(): Promise<string> {
  const { data, error } = await supabase.functions.invoke('compta-bridge-connect', {
    body: { action: 'start' },
  });
  if (error) throw error;
  const url = (data as { url?: string } | null)?.url;
  if (!url) throw new Error('Aucune URL Bridge retournée');
  return url;
}

// =============================================================
// Utilities
// =============================================================
export function formatEUR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(n);
}

export function nextDeadlineLabel(deadline: string): string {
  const days = Math.ceil(
    (new Date(deadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  if (days < 0) return `En retard de ${-days}j`;
  if (days === 0) return "Aujourd'hui";
  if (days === 1) return 'Demain';
  if (days <= 7) return `Dans ${days}j`;
  return new Date(deadline).toLocaleDateString('fr-FR');
}

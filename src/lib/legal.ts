// Frontend client for the Legal Agent module.
// All tables live in the `purama_ai` schema.
import { supabase } from '@/integrations/supabase/client';

type AnyTable = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sb = () => (supabase as unknown as { from: (t: string) => AnyTable });

// =============================================================
// Types
// =============================================================
export type UserType =
  | 'particulier' | 'auto_entrepreneur' | 'sasu' | 'sas' | 'sarl'
  | 'eurl' | 'association' | 'sci';

export type DocumentStatus = 'draft' | 'review' | 'final' | 'signed' | 'sent' | 'archived';
export type CaseStatus = 'open' | 'in_progress' | 'waiting' | 'won' | 'lost' | 'settled' | 'closed';
export type ImpayeStatus = 'overdue' | 'reminder_1' | 'reminder_2' | 'mise_en_demeure' | 'injonction' | 'huissier' | 'closed' | 'paid';
export type VeilleSeverity = 'info' | 'warning' | 'action_required' | 'urgent';

export interface LegalConfig {
  id?: string;
  user_id: string;
  is_active: boolean;
  user_type: UserType;
  company_name: string | null;
  siren: string | null;
  siret: string | null;
  naf_code: string | null;
  activity_description: string | null;
  creation_date: string | null;
  employee_count: number;
  address: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
  expertise_areas: string[];
  language: string;
  tone: string;
  auto_veille: boolean;
  auto_relance_impayes: boolean;
  notify_law_changes: boolean;
  notify_deadlines: boolean;
  notify_prescription: boolean;
  signature_image_url: string | null;
  signer_full_name: string | null;
  signer_email: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface LegalDocument {
  id: string;
  user_id: string;
  title: string;
  type: string;
  category: string | null;
  status: DocumentStatus;
  content_html: string;
  content_pdf_url: string | null;
  user_brief: string | null;
  ai_analysis: string | null;
  variables: Record<string, unknown>;
  requires_signature: boolean;
  docuseal_submission_id: string | null;
  signed_at: string | null;
  signed_pdf_url: string | null;
  signers: Array<{ name: string; email: string; role: string; signed_at?: string }>;
  sent_via: string | null;
  sent_at: string | null;
  version: number;
  parent_document_id: string | null;
  changes_summary: string | null;
  tags: string[];
  related_contact: string | null;
  related_contact_email: string | null;
  expires_at: string | null;
  renewal_alert_days: number | null;
  created_at: string;
  updated_at: string;
}

export interface LegalCase {
  id: string;
  user_id: string;
  title: string;
  case_number: string | null;
  type: string;
  status: CaseStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  parties: Array<{ name: string; role: string; email?: string; phone?: string }>;
  facts: string | null;
  timeline: Array<{ date: string; event: string; description?: string }>;
  ai_analysis: string | null;
  ai_strategy: string | null;
  ai_arguments: string[];
  ai_risks: string[];
  ai_jurisprudence: Array<{ reference: string; court: string; date: string; summary: string; relevance: string }>;
  ai_success_probability: number | null;
  ai_estimated_amount: number | null;
  deadlines: Array<{ date: string; description: string; type?: string; is_completed?: boolean }>;
  prescription_date: string | null;
  prescription_type: string | null;
  amount_claimed: number | null;
  amount_obtained: number | null;
  costs: number | null;
  document_ids: string[];
  notes: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface LegalImpaye {
  id: string;
  user_id: string;
  debtor_name: string;
  debtor_email: string | null;
  debtor_address: string | null;
  debtor_siren: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  amount: number;
  interest_rate: number;
  status: ImpayeStatus;
  reminder_1_sent_at: string | null;
  reminder_2_sent_at: string | null;
  mise_en_demeure_sent_at: string | null;
  injonction_prepared_at: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  settled: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface LegalVeille {
  id: string;
  user_id: string;
  title: string;
  type: string;
  category: string | null;
  severity: VeilleSeverity;
  summary: string;
  impact: string | null;
  action_required: string | null;
  source_url: string | null;
  source_name: string | null;
  reference: string | null;
  effective_date: string | null;
  deadline: string | null;
  is_read: boolean;
  is_actioned: boolean;
  created_at: string;
}

export interface LegalChatMessage {
  id: string;
  user_id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  category: string | null;
  documents_referenced: string[];
  cases_referenced: string[];
  sources_cited: Array<{ type: string; reference: string; url?: string }>;
  confidence: number | null;
  disclaimer_shown: boolean;
  created_at: string;
}

// =============================================================
// Static metadata
// =============================================================
export const USER_TYPES: { value: UserType; label: string }[] = [
  { value: 'particulier', label: 'Particulier' },
  { value: 'auto_entrepreneur', label: 'Auto-entrepreneur' },
  { value: 'sasu', label: 'SASU' },
  { value: 'sas', label: 'SAS' },
  { value: 'sarl', label: 'SARL' },
  { value: 'eurl', label: 'EURL' },
  { value: 'sci', label: 'SCI' },
  { value: 'association', label: 'Association' },
];

export const EXPERTISE_AREAS = [
  'commercial', 'travail', 'fiscal', 'rgpd', 'immobilier',
  'penal', 'famille', 'consommation', 'pi', 'numerique',
];

export const DOCUMENT_TYPES: { value: string; label: string; category: string }[] = [
  // Entreprise
  { value: 'statuts_sasu', label: 'Statuts SASU', category: 'entreprise' },
  { value: 'statuts_sas', label: 'Statuts SAS', category: 'entreprise' },
  { value: 'statuts_sarl', label: 'Statuts SARL', category: 'entreprise' },
  { value: 'statuts_sci', label: 'Statuts SCI', category: 'entreprise' },
  { value: 'pv_ag', label: 'PV Assemblée Générale', category: 'entreprise' },
  { value: 'pv_nomination', label: 'PV de nomination', category: 'entreprise' },
  { value: 'pv_non_remuneration', label: 'PV de non-rémunération', category: 'entreprise' },
  { value: 'pv_approbation_comptes', label: 'PV approbation des comptes', category: 'entreprise' },
  { value: 'pacte_associes', label: 'Pacte d\'associés', category: 'entreprise' },
  { value: 'convention_cca', label: 'Convention CCA', category: 'entreprise' },
  { value: 'cession_parts', label: 'Cession de parts', category: 'entreprise' },
  // Contrats
  { value: 'cdi', label: 'Contrat CDI', category: 'contrats' },
  { value: 'cdd', label: 'Contrat CDD', category: 'contrats' },
  { value: 'contrat_prestation', label: 'Contrat de prestation', category: 'contrats' },
  { value: 'contrat_commercial', label: 'Contrat commercial', category: 'contrats' },
  { value: 'nda', label: 'NDA / Confidentialité', category: 'contrats' },
  { value: 'contrat_freelance', label: 'Contrat freelance', category: 'contrats' },
  // Web/RGPD
  { value: 'cgv', label: 'CGV', category: 'web' },
  { value: 'cgu', label: 'CGU', category: 'web' },
  { value: 'mentions_legales', label: 'Mentions légales', category: 'web' },
  { value: 'politique_confidentialite', label: 'Politique de confidentialité', category: 'web' },
  { value: 'registre_traitement', label: 'Registre des traitements', category: 'web' },
  { value: 'pia', label: 'PIA (analyse d\'impact)', category: 'web' },
  // Immobilier
  { value: 'bail_habitation', label: 'Bail d\'habitation', category: 'immobilier' },
  { value: 'bail_commercial', label: 'Bail commercial', category: 'immobilier' },
  { value: 'bail_professionnel', label: 'Bail professionnel', category: 'immobilier' },
  // Recouvrement
  { value: 'mise_en_demeure', label: 'Mise en demeure', category: 'recouvrement' },
  { value: 'injonction_payer', label: 'Injonction de payer', category: 'recouvrement' },
  // Vie courante
  { value: 'lettre_resiliation', label: 'Lettre de résiliation', category: 'vie_courante' },
  { value: 'lettre_contestation', label: 'Lettre de contestation', category: 'vie_courante' },
  { value: 'lettre_reclamation', label: 'Lettre de réclamation', category: 'vie_courante' },
  // Travail
  { value: 'lettre_demission', label: 'Lettre de démission', category: 'travail' },
  { value: 'rupture_conventionnelle', label: 'Rupture conventionnelle', category: 'travail' },
  { value: 'custom', label: 'Document personnalisé', category: 'autre' },
];

export const CATEGORIES = [
  { value: 'entreprise', label: 'Entreprise & société', emoji: '🏢' },
  { value: 'contrats', label: 'Contrats', emoji: '📝' },
  { value: 'web', label: 'Web & RGPD', emoji: '🌐' },
  { value: 'immobilier', label: 'Immobilier', emoji: '🏠' },
  { value: 'recouvrement', label: 'Recouvrement', emoji: '💰' },
  { value: 'vie_courante', label: 'Vie courante', emoji: '✉️' },
  { value: 'travail', label: 'Travail', emoji: '💼' },
  { value: 'autre', label: 'Autre', emoji: '📂' },
];

export const IMPAYE_STATUS_META: Record<ImpayeStatus, { label: string; color: string; emoji: string }> = {
  overdue: { label: 'En retard', color: 'text-yellow-400', emoji: '⏰' },
  reminder_1: { label: 'Relance 1', color: 'text-orange-400', emoji: '🔁' },
  reminder_2: { label: 'Relance 2', color: 'text-orange-500', emoji: '🔁' },
  mise_en_demeure: { label: 'Mise en demeure', color: 'text-red-400', emoji: '📨' },
  injonction: { label: 'Injonction de payer', color: 'text-red-500', emoji: '⚖️' },
  huissier: { label: 'Huissier', color: 'text-red-600', emoji: '🔨' },
  closed: { label: 'Clos', color: 'text-muted-foreground', emoji: '🔒' },
  paid: { label: 'Payé', color: 'text-emerald-400', emoji: '✅' },
};

const DEFAULT_CONFIG: Omit<LegalConfig, 'user_id'> = {
  is_active: true,
  user_type: 'sasu',
  company_name: null,
  siren: null,
  siret: null,
  naf_code: null,
  activity_description: null,
  creation_date: null,
  employee_count: 0,
  address: null,
  postal_code: null,
  city: null,
  country: 'FR',
  expertise_areas: ['commercial', 'travail', 'fiscal', 'rgpd', 'immobilier'],
  language: 'fr',
  tone: 'professionnel',
  auto_veille: true,
  auto_relance_impayes: false,
  notify_law_changes: true,
  notify_deadlines: true,
  notify_prescription: true,
  signature_image_url: null,
  signer_full_name: null,
  signer_email: null,
};

// =============================================================
// CONFIG
// =============================================================
export async function getLegalConfig(userId: string): Promise<LegalConfig> {
  const { data, error } = await sb()
    .from('legal_agent_config')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (data) return data as LegalConfig;
  const insertPayload = { ...DEFAULT_CONFIG, user_id: userId };
  const { data: inserted, error: insertErr } = await sb()
    .from('legal_agent_config')
    .insert(insertPayload)
    .select()
    .single();
  if (insertErr) throw insertErr;
  return inserted as LegalConfig;
}

export async function updateLegalConfig(
  userId: string,
  patch: Partial<LegalConfig>,
): Promise<LegalConfig> {
  const { data, error } = await sb()
    .from('legal_agent_config')
    .update(patch)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data as LegalConfig;
}

// =============================================================
// CHAT (delegated to edge function)
// =============================================================
export async function sendChatMessage(
  sessionId: string,
  message: string,
): Promise<{ reply: string; sources: Array<{ type: string; reference: string; url?: string }> }> {
  const { data, error } = await supabase.functions.invoke('legal-chat', {
    body: { session_id: sessionId, message },
  });
  if (error) throw error;
  return data as { reply: string; sources: Array<{ type: string; reference: string; url?: string }> };
}

export async function listChatSessions(userId: string) {
  const { data, error } = await sb()
    .from('legal_chat_history')
    .select('session_id, content, created_at')
    .eq('user_id', userId)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  // Group by session_id, keep first message as title
  const map = new Map<string, { session_id: string; title: string; created_at: string }>();
  for (const row of (data ?? []) as Array<{ session_id: string; content: string; created_at: string }>) {
    if (!map.has(row.session_id)) {
      map.set(row.session_id, {
        session_id: row.session_id,
        title: row.content.slice(0, 60),
        created_at: row.created_at,
      });
    }
  }
  return [...map.values()];
}

export async function listChatMessages(
  userId: string,
  sessionId: string,
): Promise<LegalChatMessage[]> {
  const { data, error } = await sb()
    .from('legal_chat_history')
    .select('*')
    .eq('user_id', userId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as LegalChatMessage[];
}

// =============================================================
// DOCUMENTS
// =============================================================
export async function listDocuments(
  userId: string,
  opts: { type?: string; category?: string; status?: DocumentStatus } = {},
): Promise<LegalDocument[]> {
  let q = sb()
    .from('legal_documents')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (opts.type) q = q.eq('type', opts.type);
  if (opts.category) q = q.eq('category', opts.category);
  if (opts.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as LegalDocument[];
}

export async function generateDocument(params: {
  type: string;
  brief: string;
  variables?: Record<string, unknown>;
  related_contact?: string;
  related_contact_email?: string;
}): Promise<LegalDocument> {
  const { data, error } = await supabase.functions.invoke('legal-generate-document', {
    body: params,
  });
  if (error) throw error;
  return data as LegalDocument;
}

export async function analyzeDocument(content: string): Promise<{
  summary: string;
  abusive_clauses: string[];
  risks: string[];
  recommendations: string[];
  score: number;
}> {
  const { data, error } = await supabase.functions.invoke('legal-analyze-document', {
    body: { content },
  });
  if (error) throw error;
  return data as {
    summary: string;
    abusive_clauses: string[];
    risks: string[];
    recommendations: string[];
    score: number;
  };
}

export async function deleteDocument(id: string): Promise<void> {
  const { error } = await sb().from('legal_documents').delete().eq('id', id);
  if (error) throw error;
}

export async function sendDocumentForSignature(
  documentId: string,
  signers: Array<{ name: string; email: string }>,
): Promise<{ docuseal_submission_id: string }> {
  const { data, error } = await supabase.functions.invoke('legal-send-signature', {
    body: { document_id: documentId, signers },
  });
  if (error) throw error;
  return data as { docuseal_submission_id: string };
}

// =============================================================
// CASES
// =============================================================
export async function listCases(userId: string): Promise<LegalCase[]> {
  const { data, error } = await sb()
    .from('legal_cases')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as LegalCase[];
}

export async function createCase(
  userId: string,
  caseData: Partial<LegalCase>,
): Promise<LegalCase> {
  const { data, error } = await sb()
    .from('legal_cases')
    .insert({ ...caseData, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data as LegalCase;
}

export async function buildCase(params: {
  title: string;
  type: string;
  facts: string;
  parties: Array<{ name: string; role: string; email?: string }>;
}): Promise<LegalCase> {
  const { data, error } = await supabase.functions.invoke('legal-build-case', {
    body: params,
  });
  if (error) throw error;
  return data as LegalCase;
}

export async function deleteCase(id: string): Promise<void> {
  const { error } = await sb().from('legal_cases').delete().eq('id', id);
  if (error) throw error;
}

// =============================================================
// IMPAYÉS
// =============================================================
export async function listImpayes(userId: string): Promise<LegalImpaye[]> {
  const { data, error } = await sb()
    .from('legal_impayes')
    .select('*')
    .eq('user_id', userId)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as LegalImpaye[];
}

export async function createImpaye(
  userId: string,
  impaye: Partial<LegalImpaye>,
): Promise<LegalImpaye> {
  const { data, error } = await sb()
    .from('legal_impayes')
    .insert({ ...impaye, user_id: userId })
    .select()
    .single();
  if (error) throw error;
  return data as LegalImpaye;
}

export async function updateImpaye(
  id: string,
  patch: Partial<LegalImpaye>,
): Promise<LegalImpaye> {
  const { data, error } = await sb()
    .from('legal_impayes')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data as LegalImpaye;
}

export async function deleteImpaye(id: string): Promise<void> {
  const { error } = await sb().from('legal_impayes').delete().eq('id', id);
  if (error) throw error;
}

// =============================================================
// VEILLE
// =============================================================
export async function listVeille(userId: string, limit = 100): Promise<LegalVeille[]> {
  const { data, error } = await sb()
    .from('legal_veille')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as LegalVeille[];
}

export async function markVeilleRead(id: string): Promise<void> {
  const { error } = await sb()
    .from('legal_veille')
    .update({ is_read: true })
    .eq('id', id);
  if (error) throw error;
}

// =============================================================
// Utils
// =============================================================
export function formatEUR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n);
}

export function newSessionId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'session-' + Math.random().toString(36).slice(2);
}

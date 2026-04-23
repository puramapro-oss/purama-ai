// DocuSeal types + Zod validation schemas
// Shared between frontend (Vite) and backend (Supabase Edge Functions / Deno)

import { z } from 'zod';

export type ContractStatus =
  | 'draft' | 'sent' | 'opened' | 'signed' | 'declined' | 'cancelled' | 'expired';

export type SignerRole = 'ambassadeur' | 'purama_rep' | 'business_partner' | 'witness';

export type ContractEventType =
  | 'created' | 'sent' | 'opened' | 'signed' | 'declined'
  | 'reminded' | 'cancelled' | 'expired'
  | 'ots_stamped' | 'ots_verified' | 'anonymized';

export type AmbassadeurTier =
  | 'bronze' | 'argent' | 'or' | 'platine' | 'eternel';

export interface Contract {
  id: string;
  user_id: string;
  app_slug: string;
  template_slug: string;
  status: ContractStatus;
  docuseal_submission_id: number | null;
  docuseal_template_id: number | null;
  pdf_url: string | null;
  pdf_storage_path: string | null;
  pdf_original_url: string | null;
  ots_stamp_hash: string | null;
  ots_proof: string | null;
  ots_verified_at: string | null;
  ots_block_height: number | null;
  ots_btc_timestamp: string | null;
  commission_rate: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  signed_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
}

export interface ContractSigner {
  id: string;
  contract_id: string;
  email: string;
  name: string;
  role: SignerRole;
  order_index: number;
  signed: boolean;
  signed_at: string | null;
  opened_at: string | null;
  declined_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  signature_image_url: string | null;
  docuseal_submitter_id: number | null;
}

// ─── DocuSeal API shapes ──────────────────────────────────────────────
export interface DocusealTemplate {
  id: number;
  slug: string;
  name: string;
  schema: Array<{ attachment_uuid: string; name: string }>;
  fields: Array<{
    uuid: string;
    submitter_uuid: string;
    name: string;
    type: string;
    required: boolean;
  }>;
  submitters: Array<{ name: string; uuid: string }>;
  created_at: string;
  updated_at: string;
}

export interface DocusealSubmitter {
  id: number;
  submission_id: number;
  uuid: string;
  email: string;
  name: string | null;
  slug: string;
  status: 'awaiting' | 'opened' | 'completed' | 'declined' | 'sent';
  sent_at: string | null;
  opened_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  role: string;
  values: Array<{ field: string; value: string }>;
}

export interface DocusealSubmission {
  id: number;
  template_id: number;
  created_at: string;
  updated_at: string;
  submitters: DocusealSubmitter[];
  audit_log_url?: string;
  combined_document_url?: string;
  status: string;
}

// ─── Webhook payload shape (from DocuSeal) ────────────────────────────
export interface DocusealWebhookPayload {
  event_type: 'form.viewed' | 'form.started' | 'form.completed'
            | 'form.declined' | 'submission.created' | 'submission.expired';
  timestamp: string;
  data: DocusealSubmitter | DocusealSubmission;
}

// ─── Ambassadeur commission rates ─────────────────────────────────────
export const AMBASSADEUR_TIERS: Record<AmbassadeurTier, { rate: number; minReferrals: number; label: string }> = {
  bronze:  { rate: 10, minReferrals: 10,    label: 'Bronze' },
  argent:  { rate: 15, minReferrals: 25,    label: 'Argent' },
  or:      { rate: 20, minReferrals: 50,    label: 'Or' },
  platine: { rate: 25, minReferrals: 100,   label: 'Platine' },
  eternel: { rate: 30, minReferrals: 10000, label: 'Éternel (à vie)' },
};

// ─── Zod schemas (input validation) ───────────────────────────────────
export const CreateContractInputSchema = z.object({
  user_id: z.string().uuid().optional(),
  app_slug: z.string().min(1).max(64),
  template_slug: z.string().min(1).max(64),
  signer: z.object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    phone: z.string().optional(),
  }),
  metadata: z.record(z.unknown()).default({}),
  variables: z.record(z.string()).optional(),
  dual_signer: z.boolean().default(true),
  redirect_url: z.string().url().optional(),
});

export type CreateContractInput = z.infer<typeof CreateContractInputSchema>;

export const WebhookPayloadSchema = z.object({
  event_type: z.string(),
  timestamp: z.string().optional(),
  data: z.record(z.unknown()),
});

export const CrossAppJwtPayloadSchema = z.object({
  iss: z.string(),
  aud: z.literal('purama-contracts-hub'),
  app_slug: z.string(),
  iat: z.number(),
  exp: z.number(),
  jti: z.string().optional(),
});

export type CrossAppJwtPayload = z.infer<typeof CrossAppJwtPayloadSchema>;

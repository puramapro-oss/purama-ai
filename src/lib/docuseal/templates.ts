// DocuSeal template metadata — 8 templates for Purama ecosystem
// HTML content lives in infra/docuseal/templates/*.html (Phase 4)

import type { AmbassadeurTier } from './types';

export interface TemplateMetadata {
  slug: string;
  name: string;
  description: string;
  tier_required?: AmbassadeurTier | null;
  commission_rate?: number;
  duration_months: number;
  variables: string[];
  dual_signer: boolean;
  auto_reminder: boolean;
}

export const CONTRACT_TEMPLATES: Record<string, TemplateMetadata> = {
  'ambassadeur-bronze': {
    slug: 'ambassadeur-bronze',
    name: 'Contrat Ambassadeur Bronze',
    description: 'Programme ambassadeur Purama — palier Bronze (10% commission récurrente)',
    tier_required: 'bronze',
    commission_rate: 10,
    duration_months: 12,
    variables: [
      'user_full_name', 'user_email', 'user_address', 'user_city',
      'user_postal_code', 'user_country', 'user_phone',
      'user_siret', 'user_iban', 'user_social_links',
      'commission_rate', 'contract_date', 'start_date', 'end_date',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'ambassadeur-argent': {
    slug: 'ambassadeur-argent',
    name: 'Contrat Ambassadeur Argent',
    description: 'Programme ambassadeur Purama — palier Argent (15% commission + early access)',
    tier_required: 'argent',
    commission_rate: 15,
    duration_months: 12,
    variables: [
      'user_full_name', 'user_email', 'user_address', 'user_city',
      'user_postal_code', 'user_country', 'user_phone',
      'user_siret', 'user_iban', 'user_social_links',
      'commission_rate', 'contract_date', 'start_date', 'end_date',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'ambassadeur-or': {
    slug: 'ambassadeur-or',
    name: 'Contrat Ambassadeur Or',
    description: 'Programme ambassadeur Purama — palier Or (20% commission + page perso)',
    tier_required: 'or',
    commission_rate: 20,
    duration_months: 12,
    variables: [
      'user_full_name', 'user_email', 'user_address', 'user_city',
      'user_postal_code', 'user_country', 'user_phone',
      'user_siret', 'user_iban', 'user_social_links',
      'commission_rate', 'contract_date', 'start_date', 'end_date',
      'page_perso_url', 'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'ambassadeur-platine': {
    slug: 'ambassadeur-platine',
    name: 'Contrat Ambassadeur Platine',
    description: 'Programme ambassadeur Purama — palier Platine (25% commission + feature prio)',
    tier_required: 'platine',
    commission_rate: 25,
    duration_months: 24,
    variables: [
      'user_full_name', 'user_email', 'user_address', 'user_city',
      'user_postal_code', 'user_country', 'user_phone',
      'user_siret', 'user_iban', 'user_social_links',
      'commission_rate', 'contract_date', 'start_date', 'end_date',
      'feature_requests_slots', 'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'ambassadeur-eternel': {
    slug: 'ambassadeur-eternel',
    name: 'Contrat Ambassadeur Éternel (héréditaire)',
    description: 'Programme ambassadeur Purama — palier Éternel (30% commission à vie, transmission héréditaire)',
    tier_required: 'eternel',
    commission_rate: 30,
    duration_months: 1200,
    variables: [
      'user_full_name', 'user_email', 'user_address', 'user_city',
      'user_postal_code', 'user_country', 'user_phone',
      'user_siret', 'user_iban', 'user_social_links',
      'commission_rate', 'contract_date', 'start_date',
      'heir_primary_name', 'heir_primary_email', 'heir_primary_relation',
      'heir_secondary_name', 'heir_secondary_email', 'heir_secondary_relation',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'partenariat-business': {
    slug: 'partenariat-business',
    name: 'Accord de Partenariat Business',
    description: 'Convention entre PURAMA SASU et partenaire business (marketplace, SME, asso)',
    tier_required: null,
    duration_months: 12,
    variables: [
      'partner_company_name', 'partner_siret', 'partner_vat',
      'partner_address', 'partner_city', 'partner_postal_code', 'partner_country',
      'partner_legal_rep_name', 'partner_legal_rep_title',
      'partnership_scope', 'commission_rate', 'minimum_volume',
      'contract_date', 'start_date', 'end_date',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'territoire-purama': {
    slug: 'territoire-purama',
    name: 'Convention Territoire Purama',
    description: 'Convention de partenariat entre PURAMA et une collectivité territoriale',
    tier_required: null,
    duration_months: 36,
    variables: [
      'municipality_name', 'municipality_siren', 'municipality_address',
      'municipality_postal_code', 'municipality_country',
      'mayor_name', 'mayor_title',
      'territory_scope', 'citizens_count', 'services_included',
      'subvention_annual_amount', 'contract_date', 'start_date', 'end_date',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
  'prestation-freelance': {
    slug: 'prestation-freelance',
    name: 'Contrat de Prestation Freelance',
    description: 'Convention freelance (micro-entreprise / auto-entrepreneur)',
    tier_required: null,
    duration_months: 3,
    variables: [
      'freelance_full_name', 'freelance_siret', 'freelance_address',
      'freelance_postal_code', 'freelance_country', 'freelance_email',
      'mission_title', 'mission_description', 'mission_deliverables',
      'hourly_rate', 'estimated_hours', 'total_amount_ht',
      'vat_applicable', 'vat_rate', 'total_amount_ttc',
      'start_date', 'end_date', 'payment_terms',
      'purama_representative_name', 'purama_representative_title',
    ],
    dual_signer: true,
    auto_reminder: true,
  },
};

export function getTemplate(slug: string): TemplateMetadata | null {
  return CONTRACT_TEMPLATES[slug] ?? null;
}

export function getAllTemplates(): TemplateMetadata[] {
  return Object.values(CONTRACT_TEMPLATES);
}

export function getAmbassadeurTemplates(): TemplateMetadata[] {
  return getAllTemplates().filter(t => t.tier_required !== null && t.tier_required !== undefined);
}

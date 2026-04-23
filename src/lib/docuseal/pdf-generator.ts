// HTML template variable substitution
// Fills {{variable_name}} placeholders from a data record. DocuSeal renders HTML → PDF.

export interface RenderVariables {
  [key: string]: string | number | boolean | null | undefined;
}

const PLACEHOLDER_REGEX = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

/**
 * Substitute {{variable}} tokens in HTML template.
 * Missing variables render as empty string (fail-open), and collected in warnings.
 */
export function renderTemplate(html: string, variables: RenderVariables): {
  html: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const rendered = html.replace(PLACEHOLDER_REGEX, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      warnings.push(`Missing variable: ${key}`);
      return '';
    }
    return String(value);
  });
  return { html: rendered, warnings };
}

/**
 * Escape HTML dangerous chars for safe interpolation.
 * Use when variable is user-controlled (name, address, etc.).
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Pre-escape all string values before rendering. Call before renderTemplate.
 */
export function sanitizeVariables(variables: RenderVariables): RenderVariables {
  const out: RenderVariables = {};
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === 'string') out[key] = escapeHtml(value);
    else out[key] = value;
  }
  return out;
}

/**
 * Build default variables for ambassadeur contracts based on tier.
 * Fills representative + dates automatically.
 */
export function buildAmbassadeurVariables(input: {
  userFullName: string;
  userEmail: string;
  userAddress: string;
  userCity: string;
  userPostalCode: string;
  userCountry: string;
  userPhone?: string;
  userSiret?: string;
  userIban: string;
  userSocialLinks?: string;
  commissionRate: number;
  durationMonths: number;
  pagePersoUrl?: string;
  featureRequestsSlots?: number;
  heirs?: Array<{ name: string; email: string; relation: string }>;
}): RenderVariables {
  const now = new Date();
  const startDate = formatDateFr(now);
  const endDate = formatDateFr(addMonths(now, input.durationMonths));

  const vars: RenderVariables = {
    user_full_name: input.userFullName,
    user_email: input.userEmail,
    user_address: input.userAddress,
    user_city: input.userCity,
    user_postal_code: input.userPostalCode,
    user_country: input.userCountry,
    user_phone: input.userPhone ?? 'Non renseigné',
    user_siret: input.userSiret ?? 'Non applicable (particulier)',
    user_iban: input.userIban,
    user_social_links: input.userSocialLinks ?? 'Non renseigné',
    commission_rate: input.commissionRate,
    contract_date: startDate,
    start_date: startDate,
    end_date: endDate,
    purama_representative_name: 'Matiss DORNIER',
    purama_representative_title: 'Président — PURAMA SASU',
  };

  if (input.pagePersoUrl) vars.page_perso_url = input.pagePersoUrl;
  if (input.featureRequestsSlots !== undefined) vars.feature_requests_slots = input.featureRequestsSlots;

  if (input.heirs) {
    vars.heir_primary_name = input.heirs[0]?.name ?? 'Non désigné';
    vars.heir_primary_email = input.heirs[0]?.email ?? '';
    vars.heir_primary_relation = input.heirs[0]?.relation ?? '';
    vars.heir_secondary_name = input.heirs[1]?.name ?? 'Non désigné';
    vars.heir_secondary_email = input.heirs[1]?.email ?? '';
    vars.heir_secondary_relation = input.heirs[1]?.relation ?? '';
  }

  return vars;
}

// ─── Date helpers ─────────────────────────────────────────────────────
function formatDateFr(d: Date): string {
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function addMonths(d: Date, months: number): Date {
  const copy = new Date(d.getTime());
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

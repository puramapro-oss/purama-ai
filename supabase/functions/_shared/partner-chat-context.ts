/** A bounded, read-only projection. Neither context nor model text conveys an execution mandate. */
type Row = Record<string, unknown>;
const text = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : null;
const percent = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;

export function partnerChatContext(prospect: Row, config: Row | null) {
  return {
    scope: "selected_partner_prospect",
    prospect: {
      id: text(prospect.id, 36), name: text(prospect.name, 250), email: text(prospect.email, 320),
      type: text(prospect.type, 50), niche: text(prospect.niche, 250),
      website: text(prospect.website, 2048), status: text(prospect.status, 50),
      has_replied: prospect.has_replied === true,
      contract_sent_at: text(prospect.contract_sent_at, 40),
      contract_signed_at: text(prospect.contract_signed_at, 40),
    },
    configured_terms: config ? {
      company_name: text(config.company_name, 250), sender_name: text(config.sender_name, 250),
      sender_email: text(config.sender_email, 320),
      commission_first_payment: percent(config.commission_first_payment),
      commission_recurring: percent(config.commission_recurring),
    } : null,
    capabilities: {
      conversation: "advice_and_drafts_only",
      contract_preparation: "explicit_button_then_existing_contract_review",
      execution_from_message: false,
    },
  };
}

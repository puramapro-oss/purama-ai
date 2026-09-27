import type { AnyToolDefinition, ToolCapability } from "./types.js";
import type { ToolJsonSchema } from "./tool-schema.js";
import { validateToolParams } from "./tool-schema.js";

export interface ToolContract {
  capability: ToolCapability;
  sensitive: boolean;
  inputSchema: ToolJsonSchema;
}

const object = (
  properties: Record<string, ToolJsonSchema>,
  required: string[] = []
): ToolJsonSchema => ({ type: "object", properties, required, additionalProperties: false });

const string = (maxLength: number, minLength = 1): ToolJsonSchema => ({
  type: "string", minLength, maxLength,
});

export const TOOL_CONTRACTS: Readonly<Record<string, ToolContract>> = Object.freeze({
  supabase_upsert: {
    capability: "internal_write",
    sensitive: false,
    inputSchema: object({
      table: { type: "string", enum: [
        "compta_transactions", "compta_invoices", "legal_documents", "legal_cases",
        "legal_impayes", "partner_prospects", "partner_emails", "email_agent_logs",
        "karta_crm_leads",
      ] },
      row: { type: "object", properties: {}, additionalProperties: true },
    }, ["table", "row"]),
  },
  supabase_select: {
    capability: "read",
    sensitive: false,
    inputSchema: object({
      table: { type: "string", enum: [
        "compta_transactions", "compta_invoices", "legal_documents", "legal_cases",
        "legal_impayes", "partner_prospects", "partner_emails", "email_agent_logs",
        "karta_crm_leads",
      ] },
      filters: { type: "object", properties: {}, additionalProperties: true },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    }, ["table"]),
  },
  gmail_create_draft: {
    capability: "external_draft",
    sensitive: false,
    inputSchema: object({
      threadId: string(200),
      to: { type: "string", minLength: 3, maxLength: 320, format: "email" },
      subject: string(998),
      body: { type: "string", minLength: 0, maxLength: 200_000 },
    }, ["threadId", "to", "subject", "body"]),
  },
  gmail_send: {
    capability: "communications",
    sensitive: true,
    inputSchema: object({
      to: { type: "string", minLength: 3, maxLength: 320, format: "email" },
      subject: string(998),
      body: { type: "string", minLength: 0, maxLength: 200_000 },
    }, ["to", "subject", "body"]),
  },
  calendar_create_event: {
    capability: "external_write",
    sensitive: true,
    inputSchema: object({
      title: string(500),
      startIso: { type: "string", minLength: 10, maxLength: 80, format: "date-time" },
      endIso: { type: "string", minLength: 10, maxLength: 80, format: "date-time" },
      attendeeEmail: { type: "string", minLength: 3, maxLength: 320, format: "email" },
    }, ["title", "startIso", "endIso"]),
  },
  stripe_list_unpaid_invoices: {
    capability: "read",
    sensitive: false,
    inputSchema: object({
      customerEmail: { type: "string", minLength: 3, maxLength: 320, format: "email" },
    }),
  },
  docuseal_create_submission: {
    capability: "legal",
    sensitive: true,
    inputSchema: object({
      templateId: string(200),
      signerName: string(200),
      signerEmail: { type: "string", minLength: 3, maxLength: 320, format: "email" },
    }, ["templateId", "signerName", "signerEmail"]),
  },
  zernio_publish: {
    capability: "external_publish",
    sensitive: true,
    inputSchema: object({
      title: string(300),
      content: string(100_000),
    }, ["title", "content"]),
  },
  apollo_search_people: {
    capability: "read",
    sensitive: false,
    inputSchema: object({
      keywords: string(500),
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }, ["keywords"]),
  },
  generate_pdf: {
    capability: "internal_write",
    sensitive: false,
    inputSchema: object({
      title: string(500),
      paragraphs: { type: "array", items: { type: "string", minLength: 0, maxLength: 20_000 }, maxItems: 200 },
      fileName: string(120),
    }, ["title", "paragraphs", "fileName"]),
  },
  web_search: {
    capability: "read",
    sensitive: false,
    inputSchema: object({ query: string(4_000) }, ["query"]),
  },
  send_notification: {
    capability: "communications",
    sensitive: false,
    inputSchema: object({
      title: string(200),
      body: string(10_000),
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
    }, ["title", "body"]),
  },
  delegate_to_agent: {
    capability: "delegation",
    sensitive: false,
    inputSchema: object({
      targetAgent: { type: "string", enum: ["email", "compta", "legal", "partner"] },
      reason: string(5_000),
    }, ["targetAgent", "reason"]),
  },
});

export function resolveToolContract(tool: AnyToolDefinition): ToolContract {
  const contract = TOOL_CONTRACTS[tool.name];
  if (!contract) throw new Error(`Outil sans contrat de sécurité: ${tool.name}`);

  if (tool.capability !== undefined && tool.capability !== contract.capability) {
    throw new Error(`Capability divergente pour ${tool.name}`);
  }
  if (tool.sensitive !== contract.sensitive) {
    throw new Error(`Classification sensible divergente pour ${tool.name}`);
  }
  if (tool.inputSchema !== undefined && JSON.stringify(tool.inputSchema) !== JSON.stringify(contract.inputSchema)) {
    throw new Error(`Schéma local divergent pour ${tool.name}`);
  }
  return contract;
}

export function validateToolCall(tool: AnyToolDefinition, params: unknown): ToolContract {
  const contract = resolveToolContract(tool);
  validateToolParams(contract.inputSchema, params);
  return contract;
}

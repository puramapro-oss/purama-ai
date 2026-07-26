import { z } from "https://deno.land/x/zod@v3.22.4/mod.ts";

// Chat schemas
export const ChatMessageSchema = z.object({
  session_id: z.string().uuid(),
  message: z.string().min(1).max(4000),
  agent_id: z.string().uuid().optional(),
  agent_type: z.string().min(1).max(50).optional(),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(8000),
  })).max(20).optional(),
});

export const AgentRunSchema = z.object({
  agent_id: z.string().uuid(),
  input: z.string().max(2000).optional(),
  trigger: z.enum(["manual", "cron", "webhook", "api"]).optional(),
});

export const LegalCaseSchema = z.object({
  title: z.string().min(1).max(200),
  type: z.string().min(1).max(50),
  facts: z.string().min(10).max(10000),
});

export const VideoScriptSchema = z.object({
  topic: z.string().min(1).max(200),
  duration: z.number().min(10).max(600),
  style: z.string().min(1).max(50).optional(),
});

export const HealthConsultationSchema = z.object({
  symptoms: z.string().min(10).max(2000),
  duration_days: z.number().min(0).max(365).optional(),
  severity: z.enum(["low", "medium", "high"]).optional(),
});

// KARTA — 12 agents "action" déclenchables manuellement (cf karta/src/engine/types.ts ACTION_AGENT_TYPES)
export const KARTA_ACTION_AGENT_TYPES = [
  "repondeur-intelligent",
  "campagnes-par-courriel",
  "pro-de-la-sensibilisation-au-froid",
  "newsletter-genie",
  "facture-pro",
  "chasseur-de-paiements",
  "rapports-financiers",
  "crm-intelligent",
  "machine-de-suivi",
  "maitre-des-publicites",
  "planificateur-d-appels",
  "reservation-intelligente",
] as const;

export const KartaTriggerSchema = z.object({
  agentType: z.enum(KARTA_ACTION_AGENT_TYPES),
});

// Helper
export function validateBody<T>(
  schema: z.ZodSchema<T>,
  body: unknown
): { ok: true; data: T } | { ok: false; error: string } {
  const result = schema.safeParse(body);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join(", "),
    };
  }
  return { ok: true, data: result.data };
}

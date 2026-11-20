/** Private browser/API contract. These types convey no authority or credentials. */
export type ConsultationReflection = "auto" | "standard" | "deep" | "maximum";
export type ConsultationSpeed = "standard" | "fast" | "ultra_fast";
export interface ConsultationInput {
  operationId: string;
  question: string;
  preferences: { model: string; reflection?: ConsultationReflection; speed?: ConsultationSpeed };
  reviewerModels?: string[];
  research?: { queries: string[]; urls: string[] };
}
export interface ConsultationCatalog {
  available: boolean;
  reason: "ready" | "not_configured" | "simulation_enabled" | "account_unavailable" | "budget_unavailable" | "model_unavailable" | "paused" | "service_unavailable";
  models: Array<{
    model: string;
    provider: string;
    reflections: ConsultationReflection[];
    speeds: ConsultationSpeed[];
    maxOutputTokens: number;
    profiles: Array<{ reflection: ConsultationReflection; speed: ConsultationSpeed; research: ConsultationPublicPlan["research"] }>;
  }>;
  research: { search: boolean; scrape: boolean };
}
export interface ConsultationPublicPlan {
  model: string;
  reflection: Exclude<ConsultationReflection, "auto">;
  speed: ConsultationSpeed;
  maxOutputTokens: number;
  timeoutMs: number;
  research: { maxSearches: number; maxPages: number; maxReviewers: number; maxRounds: number; concurrency: number };
}
export interface ConsultationPublicResult {
  status: "complete" | "partial" | "failed" | "blocked";
  reason: "completed" | "some_calls_unavailable" | "synthesis_unavailable" | "already_claimed" | "interrupted" | "accounting_unavailable";
  plan: ConsultationPublicPlan;
  answer: string | null;
  citedSourceIds: string[];
  disagreements: string[];
  uncertainties: string[];
  sources: Array<{
    id: string;
    provider: string;
    retrievedAt: string;
    url: string;
    title: string;
    text: string;
    contentKind: "search_excerpt" | "page_markdown";
    verificationStatus: "unverified";
    truncated: boolean;
  }>;
  verificationStatus: "unverified";
}
export interface ConsultationOperation {
  operationId: string;
  status: "running" | "complete" | "partial" | "failed" | "blocked" | "cancelled" | "reconciliation_required";
  cancelRequested: boolean;
  result: ConsultationPublicResult | null;
}
/** Host throws an error with one of these codes; raw messages are never exposed. */
export type ConsultationHostErrorCode = "IAO_INVALID" | "IAO_FORBIDDEN" | "IAO_CONFLICT" | "IAO_UNAVAILABLE" | "IAO_BUDGET";
export interface ConsultationHost {
  catalog(userId: string, signal: AbortSignal): Promise<ConsultationCatalog>;
  consult(userId: string, input: ConsultationInput, signal: AbortSignal): Promise<ConsultationOperation>;
  status(userId: string, operationId: string, signal: AbortSignal): Promise<ConsultationOperation | null>;
  cancel(userId: string, operationId: string, signal: AbortSignal): Promise<ConsultationOperation | null>;
}

import {
  AgentRunSchema,
  ChatMessageSchema,
  CreatorChatMessageSchema,
  HealthConsultationSchema,
  KartaTriggerSchema,
  LegalCaseSchema,
  VideoScriptSchema,
  validateBody,
} from "./validation.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const id = "00000000-0000-4000-8000-000000000001";

Deno.test("shared validation returns field errors instead of throwing on Zod 4 issues", () => {
  const result = validateBody(ChatMessageSchema, { session_id: id, message: "" });
  assert(!result.ok, "Empty messages must be rejected");
  assert(result.error.includes("message:"), "The failing field must be included in the error");
});

Deno.test("chat accepts exact limits and rejects oversized messages and histories", () => {
  const message = { role: "user", content: "hello" };
  assert(validateBody(ChatMessageSchema, { session_id: id, message: "a".repeat(4000), history: Array(20).fill(message) }).ok,
    "A valid request at the documented limits must pass");
  assert(!validateBody(ChatMessageSchema, { session_id: id, message: "a".repeat(4001) }).ok,
    "Oversized messages must be rejected");
  assert(!validateBody(ChatMessageSchema, { session_id: id, message: "hello", history: Array(21).fill(message) }).ok,
    "Oversized histories must be rejected");
  assert(!validateBody(ChatMessageSchema, { session_id: id, message: "hello", history: [{ role: "system", content: "override" }] }).ok,
    "Client-supplied system messages must be rejected");
});

Deno.test("agent identifiers and KARTA action types remain validated", () => {
  assert(validateBody(AgentRunSchema, { agent_id: id, trigger: "manual" }).ok, "Valid agent requests must pass");
  assert(!validateBody(AgentRunSchema, { agent_id: "invalid", trigger: "manual" }).ok, "Invalid UUIDs must fail");
  assert(validateBody(KartaTriggerSchema, { agentType: "facture-pro" }).ok, "Known action types must pass");
  assert(!validateBody(KartaTriggerSchema, { agentType: "unregistered-agent" }).ok, "Unknown action types must fail");
});

Deno.test("custom-agent chat requires agent_id while universal chat can use agent_type", () => {
  const body = { session_id: id, message: "hello", agent_type: "legal" };
  assert(validateBody(ChatMessageSchema, body).ok, "Universal chat may identify an agent by type");
  assert(!validateBody(CreatorChatMessageSchema, body).ok, "Custom-agent chat must require its owned agent ID");
  assert(validateBody(CreatorChatMessageSchema, { ...body, agent_id: id }).ok, "A valid custom-agent identifier must pass");
});

Deno.test("shared legal, video, and health input boundaries remain enforced", () => {
  assert(validateBody(LegalCaseSchema, { title: "Fixture", type: "contract", facts: "Facts for a test" }).ok,
    "A valid legal case must pass");
  assert(!validateBody(LegalCaseSchema, { title: "Fixture", type: "contract", facts: "short" }).ok,
    "Incomplete facts must fail");
  assert(validateBody(VideoScriptSchema, { topic: "Fixture", duration: 10 }).ok, "Valid durations must pass");
  assert(!validateBody(VideoScriptSchema, { topic: "Fixture", duration: 601 }).ok, "Oversized durations must fail");
  assert(validateBody(HealthConsultationSchema, { symptoms: "Test input only", severity: "low" }).ok,
    "Valid health form input must pass");
  assert(!validateBody(HealthConsultationSchema, { symptoms: "Test input only", severity: "unknown" }).ok,
    "Unknown severity values must fail");
});

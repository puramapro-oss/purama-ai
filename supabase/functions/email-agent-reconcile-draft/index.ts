import { createEmailAgentRuntime } from "../_shared/email-agent-runtime.ts";
import { createDraftReconciler } from "./handler.ts";

Deno.serve(createDraftReconciler(createEmailAgentRuntime()));

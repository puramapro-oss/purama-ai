import { createEmailAgentRuntime } from "../_shared/email-agent-runtime.ts";
import { createDraftSender } from "./handler.ts";

Deno.serve(createDraftSender(createEmailAgentRuntime()));

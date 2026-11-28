import { createEmailAgentRuntime } from "../_shared/email-agent-runtime.ts";
import { verifyBearerSecret } from "../_shared/webhook-security.ts";
import { createPartnerReplyHandler } from "./handler.ts";

const runtime=createEmailAgentRuntime();
const serviceSecret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
Deno.serve(createPartnerReplyHandler({
  ...runtime,
  authenticateScheduled:(token)=>verifyBearerSecret("Bearer "+token,serviceSecret),
  resendApiKey:Deno.env.get("RESEND_API_KEY")??"",
}));

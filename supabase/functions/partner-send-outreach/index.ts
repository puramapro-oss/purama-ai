// POST { prospect_id, type?: "outreach" | "relance_1" | "relance_2" | "relance_3" }
// POST { action: "approve", email_id, approval_version } approves the frozen preview.
// Identity is resolved server-side; the SQL migration enforces durable reservations.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPartnerOutreachHandler } from "./handler.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
  db: { schema: "purama_ai" },
});
const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
  db: { schema: "purama_ai" },
});

Deno.serve(createPartnerOutreachHandler({
  async authenticate(token) {
    const { data, error } = await userClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async rpc(name, args) {
    const { data, error } = await admin.rpc(name, args);
    return { data, error };
  },
  fetch,
  anthropicApiKey: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  // Preserve the source branch's model unless the existing deployment explicitly configures one.
  anthropicModel: Deno.env.get("ANTHROPIC_MODEL_MAIN") ?? "claude-sonnet-4-20250514",
  resendApiKey: Deno.env.get("RESEND_API_KEY") ?? "",
}));

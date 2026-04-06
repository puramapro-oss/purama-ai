// Partner Agent — Send a personalized outreach email via Claude + Resend
// POST { prospect_id }
// 1. Fetch prospect + sender config
// 2. Claude rédige l'email (objet + corps HTML)
// 3. Resend envoie
// 4. Insert dans partner_emails + bump prospect status
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const token = auth.replace("Bearer ", "");

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: "purama_ai" },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const userId = userData.user.id;

    const { prospect_id, type } = (await req.json()) as {
      prospect_id?: string;
      type?: string;
    };
    if (!prospect_id) return json({ error: "prospect_id required" }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const { data: prospect, error: pErr } = await admin
      .from("partner_prospects")
      .select("*")
      .eq("id", prospect_id)
      .eq("user_id", userId)
      .single();
    if (pErr || !prospect) return json({ error: "Prospect not found" }, 404);
    if (!prospect.email) return json({ error: "Prospect has no email" }, 400);

    const { data: cfg, error: cErr } = await admin
      .from("partner_agent_config")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (cErr || !cfg) return json({ error: "Config missing" }, 400);
    if (!cfg.sender_email || !cfg.sender_name) {
      return json({ error: "Sender identity not configured" }, 400);
    }

    const emailType = type ?? (prospect.relance_count > 0 ? `relance_${prospect.relance_count}` : "outreach");

    // Compose Claude prompt
    const tonePrompt = cfg.outreach_tone === "custom" && cfg.custom_tone_prompt
      ? cfg.custom_tone_prompt
      : `Ton ${cfg.outreach_tone}, court (5-8 lignes), personnalisé (mentionne leur contenu / leur niche), zéro formule générique.`;

    const claudeSystem = `Tu rédiges un email de prospection partenariat pour ${cfg.company_name}.
${tonePrompt}
Tu DOIS retourner UNIQUEMENT un JSON valide: { "subject": "...", "body_html": "..." }
- subject: accrocheur, max 60 caractères, jamais "Partenariat" tout seul
- body_html: HTML simple (p, br, strong, a) — pas de <html><body>
- Mentionne ${cfg.commission_first_payment}% commission 1er paiement + ${cfg.commission_recurring}% récurrent
- Termine par la signature: ${cfg.sender_name}, ${cfg.sender_title ?? "Fondateur"}, ${cfg.company_name}
- Tutoiement si influenceur, vouvoiement si association/média/commerce.`;

    const claudeUser = `Prospect:
Nom: ${prospect.name}
Type: ${prospect.type}
Niche: ${prospect.niche ?? "inconnue"}
Site: ${prospect.website ?? "—"}
Followers: ${prospect.followers_count ?? "—"}
Notes IA: ${prospect.ai_reasoning ?? "—"}

Type d'email: ${emailType}
${emailType.startsWith("relance") ? "→ relance courte, angle différent du précédent, valeur ajoutée concrète." : "→ premier contact."}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1500,
        system: claudeSystem,
        messages: [{ role: "user", content: claudeUser }],
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as { content: Array<{ text: string }> };
    const raw = claudeJson.content?.[0]?.text ?? "{}";
    let drafted: { subject: string; body_html: string } = { subject: "", body_html: "" };
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      drafted = JSON.parse(m ? m[0] : raw);
    } catch {
      return json({ error: "Claude response parse failed" }, 502);
    }
    if (!drafted.subject || !drafted.body_html) {
      return json({ error: "Empty draft from Claude" }, 502);
    }

    // Insert email row first (status=draft) so we have an id
    const { data: emailRow, error: insErr } = await admin
      .from("partner_emails")
      .insert({
        user_id: userId,
        prospect_id,
        type: emailType,
        subject: drafted.subject,
        body_html: drafted.body_html,
        status: "draft",
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // If approval required, stop here
    if (cfg.require_approval_outreach) {
      await admin
        .from("partner_emails")
        .update({ status: "pending_approval" })
        .eq("id", emailRow.id);
      return json({ ok: true, status: "pending_approval", email_id: emailRow.id });
    }

    // Send via Resend
    if (!RESEND_API_KEY) {
      return json({ error: "RESEND_API_KEY not configured" }, 503);
    }
    const fromName = cfg.sender_name.replace(/[<>"]/g, "");
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${fromName} <${cfg.sender_email}>`,
        to: prospect.email,
        subject: drafted.subject,
        html: drafted.body_html,
        reply_to: cfg.sender_email,
      }),
    });

    if (!resendRes.ok) {
      const t = await resendRes.text();
      console.error("[resend]", t);
      await admin
        .from("partner_emails")
        .update({ status: "failed" })
        .eq("id", emailRow.id);
      return json({ error: "Resend send failed", details: t }, 502);
    }
    const resendJson = await resendRes.json() as { id?: string };

    // Mark sent
    await admin
      .from("partner_emails")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        resend_message_id: resendJson.id ?? null,
      })
      .eq("id", emailRow.id);

    // Bump prospect status
    const newStatus = emailType.startsWith("relance") ? emailType : "contacted";
    const nextActionAt = new Date();
    nextActionAt.setDate(nextActionAt.getDate() + (
      prospect.relance_count === 0 ? cfg.relance_1_delay_days
      : prospect.relance_count === 1 ? cfg.relance_2_delay_days
      : cfg.relance_3_delay_days
    ));
    await admin
      .from("partner_prospects")
      .update({
        status: newStatus,
        first_contact_at: prospect.first_contact_at ?? new Date().toISOString(),
        last_contact_at: new Date().toISOString(),
        relance_count: prospect.relance_count + (emailType.startsWith("relance") ? 1 : 0),
        next_action_at: nextActionAt.toISOString(),
      })
      .eq("id", prospect_id);

    return json({ ok: true, status: "sent", email_id: emailRow.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[partner-send-outreach]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

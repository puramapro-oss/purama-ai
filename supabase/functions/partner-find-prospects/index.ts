// Partner Agent — Find prospects via Tavily + Claude
// POST { query, niche?, type? }
// 1. Tavily Search to find candidate URLs/profiles
// 2. Claude to extract structured prospect info + score 0-100
// 3. Insert into partner_prospects (skip duplicates by email)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

interface FindBody {
  query: string;
  niche?: string;
  type?: string;
}

interface ExtractedProspect {
  name: string;
  email: string | null;
  website: string | null;
  type: string;
  niche: string | null;
  followers_count: number | null;
  ai_score: number;
  ai_reasoning: string;
  social_links?: Record<string, string>;
}

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

    const body = (await req.json()) as FindBody;
    if (!body.query) return json({ error: "query required" }, 400);

    if (!TAVILY_API_KEY) return json({ error: "TAVILY_API_KEY not configured" }, 503);
    if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not configured" }, 503);

    // 1. Tavily search
    const searchQuery = body.niche
      ? `${body.query} ${body.niche} contact email France`
      : `${body.query} contact email France`;

    const tavilyRes = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: searchQuery,
        search_depth: "advanced",
        max_results: 8,
        include_answer: false,
      }),
    });
    if (!tavilyRes.ok) {
      const t = await tavilyRes.text();
      console.error("[tavily]", t);
      return json({ error: "Tavily search failed", details: t }, 502);
    }
    const tavilyJson = await tavilyRes.json() as {
      results: Array<{ title: string; url: string; content: string }>;
    };
    const results = tavilyJson.results ?? [];

    if (results.length === 0) {
      return json({ inserted: 0, prospects: [] });
    }

    // 2. Claude extract + score
    const claudePrompt = `Tu es un expert en développement de partenariats français pour des outils SaaS B2B/B2C.
Analyse ces résultats de recherche web et identifie les meilleurs prospects pour un programme partenariat.

Type recherché: ${body.type ?? "tout"}
Niche: ${body.niche ?? "tout"}
Requête initiale: ${body.query}

Pour chaque prospect identifié, retourne un objet avec:
- name: nom de la personne / entité (jamais le titre de l'article)
- email: email de contact si trouvable dans le contenu, sinon null
- website: URL principale (pas l'URL de l'article)
- type: 'influencer' | 'website' | 'association' | 'media' | 'commerce' | 'other'
- niche: la niche thématique principale
- followers_count: estimation si mentionnée, sinon null
- ai_score: 0-100 (audience + pertinence niche + facilité de contact + qualité)
- ai_reasoning: 1 phrase courte expliquant le score
- social_links: { instagram?, youtube?, tiktok?, twitter?, linkedin? }

Résultats à analyser:
${results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.content.slice(0, 400)}`).join("\n\n")}

Retourne UNIQUEMENT un JSON valide: { "prospects": [...] }`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2500,
        messages: [{ role: "user", content: claudePrompt }],
      }),
    });
    if (!claudeRes.ok) {
      const t = await claudeRes.text();
      return json({ error: "Claude failed", details: t }, 502);
    }
    const claudeJson = await claudeRes.json() as {
      content: Array<{ text: string }>;
    };
    const raw = claudeJson.content?.[0]?.text ?? "{}";
    let parsed: { prospects: ExtractedProspect[] } = { prospects: [] };
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : raw);
    } catch (e) {
      console.error("[claude] parse error", e, raw.slice(0, 200));
      return json({ error: "Claude response parse failed" }, 502);
    }

    const extracted = parsed.prospects ?? [];
    if (extracted.length === 0) {
      return json({ inserted: 0, prospects: [] });
    }

    // 3. Insert (deduplicate by email when present)
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      db: { schema: "purama_ai" },
    });

    const inserted: unknown[] = [];
    for (const p of extracted) {
      // Skip if email already exists for this user
      if (p.email) {
        const { data: existing } = await admin
          .from("partner_prospects")
          .select("id")
          .eq("user_id", userId)
          .eq("email", p.email)
          .maybeSingle();
        if (existing) continue;
      }
      const validTypes = ["influencer", "website", "association", "media", "commerce", "other"];
      const type = validTypes.includes(p.type) ? p.type : "other";

      const { data: row, error: insErr } = await admin
        .from("partner_prospects")
        .insert({
          user_id: userId,
          name: p.name,
          email: p.email,
          website: p.website,
          social_links: p.social_links ?? {},
          type,
          niche: p.niche ?? body.niche ?? null,
          followers_count: p.followers_count,
          ai_score: Math.max(0, Math.min(100, Math.round(p.ai_score))),
          ai_reasoning: p.ai_reasoning,
          source: "ai_search",
          found_by_ai: true,
          status: "ready_to_contact",
        })
        .select()
        .single();
      if (!insErr && row) inserted.push(row);
    }

    // Bump stats
    await admin.rpc("noop").catch(() => {/* ignore */});

    return json({ inserted: inserted.length, prospects: inserted });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[partner-find-prospects]", msg);
    return json({ error: msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

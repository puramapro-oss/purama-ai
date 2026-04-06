import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.32.1";
import {
  corsHeaders,
  publishPost,
  type Platform,
} from "../_shared/zernio.ts";

interface PublishBody {
  content: string;
  mediaUrls?: string[];
  contentType?: "text" | "image" | "video" | "carousel" | "reel";
  agentName?: string;
  platforms?: Platform[];
  scheduledAt?: string;
  forceCaption?: boolean;
}

async function generateCaption(params: {
  content: string;
  contentType: string;
  agentName?: string;
}): Promise<{ caption: string; hashtags: string[] }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return { caption: params.content, hashtags: [] };
  }
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 600,
    system:
      `Tu es un expert viral en réseaux sociaux. À partir du contenu fourni, génère une caption engageante (max 2-3 phrases, ton naturel, hooks forts) et 5 à 10 hashtags pertinents (sans le #). Réponds STRICTEMENT en JSON: {"caption": "...", "hashtags": ["...", "..."]}. Aucun markdown, aucune explication.`,
    messages: [
      {
        role: "user",
        content:
          `Contenu: ${params.content}\nType: ${params.contentType}\nAgent: ${params.agentName || "PURAMA AI"}`,
      },
    ],
  });

  const block = msg.content[0];
  const text = block && block.type === "text" ? block.text : "";
  try {
    const parsed = JSON.parse(text);
    return {
      caption: String(parsed.caption ?? params.content),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String) : [],
    };
  } catch {
    return { caption: params.content, hashtags: [] };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { db: { schema: 'purama_ai' } }
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const user = userData.user;

    const body = (await req.json()) as PublishBody;
    if (!body.content && !(body.mediaUrls && body.mediaUrls.length)) {
      return new Response(
        JSON.stringify({ error: "Content or mediaUrls required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 1. Fetch active accounts
    const { data: accounts, error: accError } = await supabase
      .from("social_accounts")
      .select("*")
      .eq("user_id", user.id)
      .eq("is_active", true);
    if (accError) throw accError;
    if (!accounts || accounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "No connected accounts" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 2. Fetch autopilot config
    const { data: config } = await supabase
      .from("social_autopilot_config")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();

    // 3. Optionally generate caption + hashtags via AI
    const shouldGenerate = body.forceCaption ?? config?.auto_caption ?? false;
    let caption = body.content || "";
    let hashtags: string[] = [];
    if (shouldGenerate && body.content) {
      try {
        const ai = await generateCaption({
          content: body.content,
          contentType: body.contentType || "text",
          agentName: body.agentName,
        });
        caption = ai.caption;
        hashtags = (config?.auto_hashtags ?? true) ? ai.hashtags : [];
      } catch (e) {
        console.error("[social-publish] AI caption error:", e);
      }
    }

    const fullText = hashtags.length
      ? `${caption}\n\n${hashtags.map((h) => `#${h}`).join(" ")}`
      : caption;

    // 4. Filter accounts by requested platforms (if any)
    const requested = body.platforms && body.platforms.length
      ? new Set(body.platforms)
      : null;
    const targetAccounts = requested
      ? accounts.filter((a) => requested.has(a.platform as Platform))
      : accounts;

    if (targetAccounts.length === 0) {
      return new Response(
        JSON.stringify({ error: "No matching connected accounts" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const platforms = targetAccounts.map((a) => a.platform as Platform);
    const profileIds = targetAccounts.map((a) => a.zernio_profile_id);

    // 5. Insert "publishing" row first
    const { data: postRow, error: insertError } = await supabase
      .from("social_posts")
      .insert({
        user_id: user.id,
        content_text: fullText,
        content_media_urls: body.mediaUrls || [],
        content_type: body.contentType || "text",
        agent_name: body.agentName,
        target_platforms: platforms,
        status: "publishing",
        scheduled_at: body.scheduledAt,
        ai_generated: shouldGenerate,
        ai_caption: caption,
        ai_hashtags: hashtags,
      })
      .select()
      .single();
    if (insertError) throw insertError;

    // 6. Publish via Zernio
    let result: Record<string, unknown> = {};
    try {
      result = await publishPost({
        text: fullText,
        mediaUrls: body.mediaUrls && body.mediaUrls.length ? body.mediaUrls : undefined,
        platforms,
        profileIds,
        scheduledAt: body.scheduledAt,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await supabase
        .from("social_posts")
        .update({
          status: "failed",
          error_message: message,
        })
        .eq("id", postRow.id);
      throw e;
    }

    // 7. Update post row
    await supabase
      .from("social_posts")
      .update({
        status: body.scheduledAt ? "scheduled" : "published",
        published_at: body.scheduledAt ? null : new Date().toISOString(),
        zernio_post_id: (result.id as string) || (result.post_id as string) || null,
        zernio_response: result,
      })
      .eq("id", postRow.id);

    return new Response(
      JSON.stringify({ success: true, post_id: postRow.id, zernio: result }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[social-publish]", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

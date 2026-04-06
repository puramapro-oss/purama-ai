import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[PROCESS-TIER-QUEUE] ${step}${detailsStr}`);
};

// Tier configuration
const TIERS = {
  bronze: { name: 'Bronze', emoji: '🥉', color: '#cd7f32', bgColor: '#cd7f3222' },
  silver: { name: 'Silver', emoji: '🥈', color: '#94a3b8', bgColor: '#94a3b822' },
  gold: { name: 'Gold', emoji: '🥇', color: '#eab308', bgColor: '#eab30822' },
};

function generateTierUpgradeEmailHtml(data: {
  beneficiaryName: string;
  previousTier: string;
  newTier: string;
  newRate: number;
  totalSales: number;
}): string {
  const prevTierConfig = TIERS[data.previousTier as keyof typeof TIERS];
  const newTierConfig = TIERS[data.newTier as keyof typeof TIERS];
  const isGold = data.newTier === 'gold';
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Félicitations ! Nouveau palier atteint</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0f;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0a0a0f;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border-radius: 16px; border: 1px solid ${isGold ? 'rgba(234, 179, 8, 0.5)' : 'rgba(255,255,255,0.1)'}; ${isGold ? 'box-shadow: 0 0 40px rgba(234, 179, 8, 0.2);' : ''}">
          <tr>
            <td style="padding: 32px 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td><span style="font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #00d4ff, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">Agentia</span></td>
                  <td align="right"><span style="display: inline-block; padding: 8px 16px; background-color: ${newTierConfig.bgColor}; color: ${newTierConfig.color}; border-radius: 20px; font-size: 14px; font-weight: 700;">${newTierConfig.emoji} Palier ${newTierConfig.name}</span></td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="padding: 0 32px 24px; text-align: center;"><div style="font-size: 64px; line-height: 1;">🎉 ${newTierConfig.emoji} 🎉</div></td></tr>
          <tr>
            <td style="padding: 0 32px 32px;">
              <h1 style="margin: 0 0 16px; font-size: 28px; font-weight: 700; color: #ffffff; text-align: center;">Félicitations ${data.beneficiaryName} !</h1>
              <p style="margin: 0 0 24px; font-size: 18px; line-height: 1.6; color: #a1a1aa; text-align: center;">Vous avez atteint le palier <strong style="color: ${newTierConfig.color};">${newTierConfig.name}</strong> !</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: rgba(0,0,0,0.3); border-radius: 12px; margin-bottom: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td width="40%" style="text-align: center; padding: 12px;">
                          <p style="margin: 0 0 8px; font-size: 32px;">${prevTierConfig.emoji}</p>
                          <p style="margin: 0; font-size: 14px; color: #71717a;">${prevTierConfig.name}</p>
                          <p style="margin: 4px 0 0; font-size: 18px; color: ${prevTierConfig.color}; font-weight: 600;">${TIERS[data.previousTier as keyof typeof TIERS] ? (data.previousTier === 'bronze' ? '9.99' : data.previousTier === 'silver' ? '19.99' : '33') : '?'}%</p>
                        </td>
                        <td width="20%" style="text-align: center; vertical-align: middle;"><span style="font-size: 24px; color: ${newTierConfig.color};">→</span></td>
                        <td width="40%" style="text-align: center; padding: 12px; background: ${newTierConfig.bgColor}; border-radius: 12px;">
                          <p style="margin: 0 0 8px; font-size: 40px;">${newTierConfig.emoji}</p>
                          <p style="margin: 0; font-size: 14px; color: ${newTierConfig.color};">${newTierConfig.name}</p>
                          <p style="margin: 4px 0 0; font-size: 24px; color: ${newTierConfig.color}; font-weight: 700;">${data.newRate}%</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-bottom: 24px;">
                <tr>
                  <td style="background: rgba(34, 197, 94, 0.1); border-radius: 12px; padding: 20px; text-align: center;">
                    <p style="margin: 0 0 4px; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 1px;">Total de ventes</p>
                    <p style="margin: 0; font-size: 32px; font-weight: bold; color: #22c55e;">${data.totalSales}</p>
                    <p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">Vous gagnez maintenant <strong style="color: ${newTierConfig.color};">${data.newRate}%</strong> sur chaque vente !</p>
                  </td>
                </tr>
              </table>
              ${isGold ? `<div style="background: linear-gradient(135deg, rgba(234, 179, 8, 0.2), rgba(234, 179, 8, 0.1)); border: 1px solid rgba(234, 179, 8, 0.3); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;"><p style="margin: 0; font-size: 16px; color: #eab308; font-weight: 600;">🌟 Vous avez atteint le palier maximum ! 🌟</p><p style="margin: 8px 0 0; font-size: 14px; color: #a1a1aa;">Profitez du taux de commission le plus élevé sur toutes vos ventes futures.</p></div>` : ''}
              <div style="text-align: center;"><a href="https://purama-ai.purama.dev/influenceur/dashboard" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">Voir mon tableau de bord →</a></div>
            </td>
          </tr>
          <tr><td style="padding: 24px 32px; border-top: 1px solid rgba(255,255,255,0.1);"><p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">Merci d'être un partenaire Agentia !<br><a href="https://purama-ai.purama.dev/influenceur/dashboard" style="color: #a855f7; text-decoration: none;">Gérer mon compte influenceur</a></p></td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    logStep("Function started - Processing tier upgrade queue");

    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { db: { schema: 'purama_ai' }, auth: { persistSession: false } }
    );

    // Fetch unprocessed tier upgrades
    const { data: pendingUpgrades, error: fetchError } = await supabaseClient
      .from('tier_upgrade_queue')
      .select('*')
      .eq('processed', false)
      .order('created_at', { ascending: true })
      .limit(50);

    if (fetchError) {
      logStep("ERROR: Failed to fetch queue", { error: fetchError.message });
      return new Response(
        JSON.stringify({ error: fetchError.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
      );
    }

    if (!pendingUpgrades || pendingUpgrades.length === 0) {
      logStep("No pending tier upgrades to process");
      return new Response(
        JSON.stringify({ success: true, processed: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    logStep("Found pending upgrades", { count: pendingUpgrades.length });

    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    let processedCount = 0;
    let emailsSent = 0;

    for (const upgrade of pendingUpgrades) {
      try {
        // Get influencer details
        const { data: influencer } = await supabaseClient
          .from('influencers')
          .select('*')
          .eq('id', upgrade.influencer_id)
          .single();

        if (!influencer) {
          logStep("Influencer not found, marking as processed", { id: upgrade.influencer_id });
          await supabaseClient
            .from('tier_upgrade_queue')
            .update({ processed: true })
            .eq('id', upgrade.id);
          continue;
        }

        const newTierConfig = TIERS[upgrade.new_tier as keyof typeof TIERS];

        // Create in-app notification
        const { error: notifError } = await supabaseClient
          .from('notifications')
          .insert({
            user_id: influencer.user_id,
            type: 'task_completed',
            title: `${newTierConfig.emoji} Nouveau palier : ${newTierConfig.name} !`,
            message: `Félicitations ! Vous avez atteint le palier ${newTierConfig.name} avec un taux de commission de ${upgrade.new_rate}%.`,
            action_url: '/influenceur/dashboard',
          });

        if (notifError) {
          logStep("ERROR: Failed to create notification", { error: notifError.message });
        } else {
          logStep("In-app notification created for", { influencer_id: influencer.id });
        }

        // Send congratulations email
        if (resendApiKey) {
          const { data: profile } = await supabaseClient
            .from('profiles')
            .select('email')
            .eq('user_id', influencer.user_id)
            .single();

          if (profile?.email) {
            try {
              const resend = new Resend(resendApiKey);
              
              const emailHtml = generateTierUpgradeEmailHtml({
                beneficiaryName: influencer.beneficiary_name || 'Partenaire',
                previousTier: upgrade.previous_tier,
                newTier: upgrade.new_tier,
                newRate: upgrade.new_rate,
                totalSales: upgrade.total_sales,
              });

              const { error: emailError } = await resend.emails.send({
                from: 'Agentia <notifications@resend.dev>',
                to: [profile.email],
                subject: `${newTierConfig.emoji} Félicitations ! Vous avez atteint le palier ${newTierConfig.name} !`,
                html: emailHtml,
              });

              if (emailError) {
                logStep("ERROR: Failed to send email", { error: emailError });
              } else {
                logStep("Email sent to", { email: profile.email });
                emailsSent++;
              }
            } catch (emailErr) {
              logStep("ERROR: Email sending failed", { error: String(emailErr) });
            }
          }
        }

        // Mark as processed
        await supabaseClient
          .from('tier_upgrade_queue')
          .update({ processed: true })
          .eq('id', upgrade.id);

        processedCount++;
        logStep("Processed upgrade", { id: upgrade.id, new_tier: upgrade.new_tier });

      } catch (itemError) {
        logStep("ERROR processing upgrade", { id: upgrade.id, error: String(itemError) });
      }
    }

    logStep("Queue processing complete", { processed: processedCount, emailsSent });

    return new Response(
      JSON.stringify({ 
        success: true, 
        processed: processedCount,
        emails_sent: emailsSent,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
    );

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR", { message: errorMessage });
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});

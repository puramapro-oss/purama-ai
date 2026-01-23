import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.2";
import { Resend } from "https://esm.sh/resend@2.0.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

const logStep = (step: string, details?: Record<string, unknown>) => {
  const detailsStr = details ? ` - ${JSON.stringify(details)}` : '';
  console.log(`[PROCESS-INFLUENCER-PAYMENTS] ${step}${detailsStr}`);
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Verify webhook secret for scheduled calls
  const webhookSecret = req.headers.get('x-webhook-secret');
  const expectedSecret = Deno.env.get('WEBHOOK_SECRET');
  
  if (webhookSecret !== expectedSecret) {
    logStep("ERROR: Unauthorized request");
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 401,
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  try {
    logStep("Function started - Processing influencer payments");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Find influencers whose links expire today
    const { data: expiringInfluencers, error: fetchError } = await supabase
      .from('influencers')
      .select('*')
      .gte('expires_at', today.toISOString())
      .lt('expires_at', tomorrow.toISOString())
      .eq('contract_status', 'signed');

    if (fetchError) {
      logStep("ERROR: Failed to fetch expiring influencers", { error: fetchError.message });
      throw fetchError;
    }

    logStep("Found expiring influencers", { count: expiringInfluencers?.length || 0 });

    const results: { influencerId: string; status: string; amount?: number }[] = [];

    for (const influencer of expiringInfluencers || []) {
      logStep("Processing influencer", { id: influencer.id, name: influencer.beneficiary_name });

      // Get all validated commissions for this influencer
      const { data: validatedCommissions, error: commError } = await supabase
        .from('commissions')
        .select('*')
        .eq('influencer_id', influencer.id)
        .eq('status', 'validated');

      if (commError) {
        logStep("ERROR: Failed to fetch commissions", { influencerId: influencer.id, error: commError.message });
        results.push({ influencerId: influencer.id, status: 'error' });
        continue;
      }

      const totalToPay = validatedCommissions?.reduce(
        (sum, c) => sum + Number(c.commission_amount), 0
      ) || 0;

      logStep("Commissions to pay", { 
        influencerId: influencer.id, 
        count: validatedCommissions?.length || 0,
        total: totalToPay 
      });

      // Minimum payout threshold: 50€
      if (totalToPay < 50) {
        logStep("Below minimum threshold, skipping payment", { 
          influencerId: influencer.id, 
          total: totalToPay,
          threshold: 50
        });
        results.push({ influencerId: influencer.id, status: 'below_threshold', amount: totalToPay });
        continue;
      }

      // Check if bank details are provided
      if (!influencer.iban || !influencer.beneficiary_name) {
        logStep("Missing bank details, cannot process payment", { influencerId: influencer.id });
        results.push({ influencerId: influencer.id, status: 'missing_bank_details', amount: totalToPay });
        
        // Notify influencer about missing bank details
        await supabase.from('notifications').insert({
          user_id: influencer.user_id,
          type: 'alert',
          title: 'Paiement en attente',
          message: `Vous avez ${totalToPay.toFixed(2)}€ de commissions à recevoir mais vos coordonnées bancaires sont manquantes.`,
          action_url: '/influenceur/dashboard',
        });
        continue;
      }

      // Mark commissions as paid
      const commissionIds = validatedCommissions?.map(c => c.id) || [];
      const { error: updateError } = await supabase
        .from('commissions')
        .update({ 
          status: 'paid',
          payment_date: new Date().toISOString(),
        })
        .in('id', commissionIds);

      if (updateError) {
        logStep("ERROR: Failed to update commissions", { error: updateError.message });
        results.push({ influencerId: influencer.id, status: 'update_error', amount: totalToPay });
        continue;
      }

      logStep("Commissions marked as paid", { influencerId: influencer.id, count: commissionIds.length });

      // Create notification for influencer
      await supabase.from('notifications').insert({
        user_id: influencer.user_id,
        type: 'task_completed',
        title: 'Paiement effectué !',
        message: `${totalToPay.toFixed(2)}€ ont été versés sur votre compte (IBAN: ${influencer.iban.slice(-4).padStart(influencer.iban.length, '*')})`,
        action_url: '/influenceur/dashboard',
      });

      // Send payment confirmation email
      const resendApiKey = Deno.env.get('RESEND_API_KEY');
      if (resendApiKey) {
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('email')
            .eq('user_id', influencer.user_id)
            .single();

          if (profile?.email) {
            const resend = new Resend(resendApiKey);
            
            await resend.emails.send({
              from: 'Agentia <notifications@resend.dev>',
              to: [profile.email],
              subject: `💸 Paiement de ${totalToPay.toFixed(2)}€ effectué`,
              html: generatePaymentEmailHtml({
                beneficiaryName: influencer.beneficiary_name,
                amount: totalToPay,
                iban: influencer.iban,
                commissionCount: commissionIds.length,
              }),
            });
            
            logStep("Payment email sent", { email: profile.email });
          }
        } catch (emailErr) {
          logStep("ERROR: Failed to send email", { error: String(emailErr) });
        }
      }

      results.push({ influencerId: influencer.id, status: 'paid', amount: totalToPay });
    }

    logStep("Processing complete", { results });

    return new Response(JSON.stringify({ 
      success: true, 
      processed: results.length,
      results 
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 200,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logStep("ERROR in process-influencer-payments", { message: errorMessage });
    return new Response(JSON.stringify({ error: errorMessage }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

function generatePaymentEmailHtml(data: {
  beneficiaryName: string;
  amount: number;
  iban: string;
  commissionCount: number;
}): string {
  const maskedIban = data.iban.slice(-4).padStart(data.iban.length, '*');
  
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Paiement effectué</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #0a0a0f;">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background-color: #0a0a0f;">
    <tr>
      <td style="padding: 40px 20px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width: 600px; margin: 0 auto; background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, rgba(255,255,255,0.02) 100%); border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 32px 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 24px; font-weight: bold; background: linear-gradient(135deg, #00d4ff, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;">
                      Agentia
                    </span>
                  </td>
                  <td align="right">
                    <span style="display: inline-block; padding: 6px 12px; background-color: #22c55e22; color: #22c55e; border-radius: 20px; font-size: 12px; font-weight: 600;">
                      💸 Paiement effectué
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Content -->
          <tr>
            <td style="padding: 0 32px 32px;">
              <h1 style="margin: 0 0 16px; font-size: 28px; font-weight: 600; color: #ffffff;">
                Félicitations ${data.beneficiaryName} ! 💸
              </h1>
              <p style="margin: 0 0 24px; font-size: 18px; line-height: 1.6; color: #a1a1aa;">
                Votre paiement de commissions a été traité avec succès.
              </p>
              
              <!-- Payment Box -->
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: rgba(34, 197, 94, 0.1); border-radius: 12px; border: 1px solid rgba(34, 197, 94, 0.3); margin-bottom: 24px;">
                <tr>
                  <td style="padding: 24px;">
                    <p style="margin: 0 0 4px; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 1px;">Montant versé</p>
                    <p style="margin: 0 0 16px; font-size: 36px; font-weight: bold; color: #22c55e;">+${data.amount.toFixed(2)}€</p>
                    
                    <p style="margin: 0 0 4px; font-size: 12px; color: #71717a; text-transform: uppercase; letter-spacing: 1px;">Compte bancaire</p>
                    <p style="margin: 0 0 16px; font-size: 14px; font-family: monospace; color: #ffffff;">${maskedIban}</p>
                    
                    <p style="margin: 0; font-size: 14px; color: #a1a1aa;">
                      Basé sur ${data.commissionCount} commission${data.commissionCount > 1 ? 's' : ''} validée${data.commissionCount > 1 ? 's' : ''}
                    </p>
                  </td>
                </tr>
              </table>
              
              <p style="margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: #71717a;">
                Le virement devrait apparaître sur votre compte dans les 2 à 5 jours ouvrés.
              </p>
              
              <a href="https://agentiapuramafr.lovable.app/influenceur/dashboard" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
                Voir mon tableau de bord →
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; border-top: 1px solid rgba(255,255,255,0.1);">
              <p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">
                Merci d'être partenaire Agentia !<br>
                <a href="https://agentiapuramafr.lovable.app/influenceur/dashboard" style="color: #a855f7; text-decoration: none;">Gérer mon compte influenceur</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}

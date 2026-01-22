import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "resend";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface AgentActivity {
  agent_name: string;
  agent_slug: string;
  total_uses: number;
  completed: number;
  pending: number;
  failed: number;
}

interface UserReport {
  user_id: string;
  email: string;
  full_name: string | null;
  total_activity: number;
  agents: AgentActivity[];
}

function generateReportHtml(report: UserReport, date: string): string {
  const agentRows = report.agents.map(agent => `
    <tr>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.1);">
        <span style="color: #ffffff; font-weight: 500;">${agent.agent_name}</span>
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: center;">
        <span style="color: #a1a1aa;">${agent.total_uses}</span>
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: center;">
        <span style="color: #22c55e;">${agent.completed}</span>
      </td>
      <td style="padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: center;">
        <span style="color: #f97316;">${agent.pending}</span>
      </td>
    </tr>
  `).join('');

  const noActivityMessage = report.total_activity === 0 
    ? `<p style="margin: 24px 0; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 8px; text-align: center; color: #a1a1aa;">
        Aucune activité enregistrée aujourd'hui. Lancez vos agents pour automatiser vos tâches !
      </p>`
    : '';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rapport quotidien Agentia</title>
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
                    <span style="display: inline-block; padding: 6px 12px; background-color: rgba(168, 85, 247, 0.2); color: #a855f7; border-radius: 20px; font-size: 12px; font-weight: 600;">
                      📊 Rapport quotidien
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- Greeting -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <h1 style="margin: 0 0 8px; font-size: 24px; font-weight: 600; color: #ffffff;">
                Bonjour${report.full_name ? ` ${report.full_name}` : ''} 👋
              </h1>
              <p style="margin: 0; font-size: 16px; color: #a1a1aa;">
                Voici le résumé de l'activité de vos agents pour le ${date}
              </p>
            </td>
          </tr>

          <!-- Stats Summary -->
          <tr>
            <td style="padding: 0 32px 24px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td style="background: linear-gradient(135deg, rgba(0, 212, 255, 0.1), rgba(0, 212, 255, 0.05)); border-radius: 12px; padding: 20px; text-align: center; width: 50%;">
                    <p style="margin: 0 0 4px; font-size: 32px; font-weight: 700; color: #00d4ff;">
                      ${report.total_activity}
                    </p>
                    <p style="margin: 0; font-size: 14px; color: #a1a1aa;">
                      Actions aujourd'hui
                    </p>
                  </td>
                  <td style="width: 16px;"></td>
                  <td style="background: linear-gradient(135deg, rgba(168, 85, 247, 0.1), rgba(168, 85, 247, 0.05)); border-radius: 12px; padding: 20px; text-align: center; width: 50%;">
                    <p style="margin: 0 0 4px; font-size: 32px; font-weight: 700; color: #a855f7;">
                      ${report.agents.length}
                    </p>
                    <p style="margin: 0; font-size: 14px; color: #a1a1aa;">
                      Agents actifs
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          ${noActivityMessage}

          <!-- Activity Table -->
          ${report.agents.length > 0 ? `
          <tr>
            <td style="padding: 0 32px 32px;">
              <h2 style="margin: 0 0 16px; font-size: 18px; font-weight: 600; color: #ffffff;">
                Détail par agent
              </h2>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background: rgba(255,255,255,0.03); border-radius: 12px; overflow: hidden;">
                <thead>
                  <tr style="background: rgba(255,255,255,0.05);">
                    <th style="padding: 12px 16px; text-align: left; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase;">Agent</th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase;">Total</th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase;">✅</th>
                    <th style="padding: 12px 16px; text-align: center; font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase;">⏳</th>
                  </tr>
                </thead>
                <tbody>
                  ${agentRows}
                </tbody>
              </table>
            </td>
          </tr>
          ` : ''}

          <!-- CTA -->
          <tr>
            <td style="padding: 0 32px 32px; text-align: center;">
              <a href="https://agentiapuramafr.lovable.app/dashboard" style="display: inline-block; padding: 14px 28px; background: linear-gradient(135deg, #00d4ff, #a855f7); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">
                Voir mon tableau de bord →
              </a>
            </td>
          </tr>
          
          <!-- Footer -->
          <tr>
            <td style="padding: 24px 32px; border-top: 1px solid rgba(255,255,255,0.1);">
              <p style="margin: 0; font-size: 12px; color: #71717a; text-align: center;">
                Vous recevez ce rapport car vous avez activé les rapports quotidiens.<br>
                <a href="https://agentiapuramafr.lovable.app/notification-settings" style="color: #a855f7; text-decoration: none;">Gérer vos préférences</a>
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const resendApiKey = Deno.env.get('RESEND_API_KEY');
    
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Get today's date range
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart);
    todayEnd.setDate(todayEnd.getDate() + 1);

    const dateStr = todayStart.toLocaleDateString('fr-FR', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Get all users with daily_report enabled
    const { data: allProfiles, error: profilesError } = await supabase
      .from('profiles')
      .select('user_id, email, full_name');

    if (profilesError) {
      console.error('Error fetching profiles:', profilesError);
      throw profilesError;
    }

    // Get preferences for users who have daily reports enabled
    const { data: preferences } = await supabase
      .from('notification_preferences')
      .select('user_id, email_enabled, daily_report_enabled');

    // Create a map of user preferences
    const preferencesMap = new Map(
      (preferences || []).map(p => [p.user_id, p])
    );

    // Filter users who have daily reports enabled (default true if no preferences)
    const eligibleUsers = (allProfiles || []).filter(profile => {
      const pref = preferencesMap.get(profile.user_id);
      const dailyReportEnabled = pref ? pref.daily_report_enabled !== false : true;
      const emailEnabled = pref ? pref.email_enabled !== false : true;
      return dailyReportEnabled && emailEnabled && profile.email;
    });

    console.log(`Processing daily reports for ${eligibleUsers.length} users`);

    // Get all agents
    const { data: agents } = await supabase
      .from('agents')
      .select('id, name, slug');

    const agentsMap = new Map(
      (agents || []).map(a => [a.id, { name: a.name, slug: a.slug }])
    );

    let reportsSent = 0;
    let emailsSent = 0;

    for (const user of eligibleUsers) {
      // Get user's activity for today
      const { data: usage } = await supabase
        .from('agent_usage')
        .select('agent_id, status, created_at')
        .eq('user_id', user.user_id)
        .gte('created_at', todayStart.toISOString())
        .lt('created_at', todayEnd.toISOString());

      // Aggregate by agent
      const agentStats = new Map<string, AgentActivity>();
      
      for (const record of usage || []) {
        const agent = agentsMap.get(record.agent_id);
        if (!agent) continue;

        if (!agentStats.has(record.agent_id)) {
          agentStats.set(record.agent_id, {
            agent_name: agent.name,
            agent_slug: agent.slug,
            total_uses: 0,
            completed: 0,
            pending: 0,
            failed: 0,
          });
        }

        const stats = agentStats.get(record.agent_id)!;
        stats.total_uses++;
        
        if (record.status === 'completed') stats.completed++;
        else if (record.status === 'pending') stats.pending++;
        else if (record.status === 'failed') stats.failed++;
      }

      const report: UserReport = {
        user_id: user.user_id,
        email: user.email,
        full_name: user.full_name,
        total_activity: usage?.length || 0,
        agents: Array.from(agentStats.values()).sort((a, b) => b.total_uses - a.total_uses),
      };

      // Create in-app notification
      await supabase
        .from('notifications')
        .insert({
          user_id: user.user_id,
          type: 'daily_report',
          title: `Rapport du ${dateStr}`,
          message: report.total_activity > 0 
            ? `${report.total_activity} action${report.total_activity > 1 ? 's' : ''} effectuée${report.total_activity > 1 ? 's' : ''} par ${report.agents.length} agent${report.agents.length > 1 ? 's' : ''}`
            : 'Aucune activité enregistrée aujourd\'hui',
          action_url: '/dashboard',
          read: false,
        });

      reportsSent++;

      // Send email if Resend is configured
      if (resendApiKey && user.email) {
        try {
          const resend = new Resend(resendApiKey);
          const emailHtml = generateReportHtml(report, dateStr);

          await resend.emails.send({
            from: 'Agentia <notifications@resend.dev>',
            to: [user.email],
            subject: `📊 Votre rapport Agentia du ${dateStr}`,
            html: emailHtml,
          });

          emailsSent++;
          console.log(`Email sent to ${user.email}`);
        } catch (emailErr) {
          console.error(`Failed to send email to ${user.email}:`, emailErr);
        }
      }
    }

    console.log(`Daily reports completed: ${reportsSent} notifications, ${emailsSent} emails`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        reports_sent: reportsSent,
        emails_sent: emailsSent,
        date: dateStr
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error generating daily reports:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: 'Failed to generate daily reports', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

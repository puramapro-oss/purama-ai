import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Handshake, Power, Settings, Users, Mail, TrendingUp, DollarSign,
  Loader2, ArrowRight, Sparkles, AlertCircle, Inbox, FileText,
  Send,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TutorialOverlay, type TutorialStep } from '@/components/shared/TutorialOverlay';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getPartnerConfig, updatePartnerConfig, listProspects,
  listActivePartners, partnerStats, formatEUR,
  PIPELINE_COLUMNS, STATUS_META,
  type PartnerConfig, type PartnerProspect, type PartnerActive,
} from '@/lib/partner';
import { AgentChatTab } from '@/components/voice/AgentChatTab';

export default function PartnerAgent() {
  const { user } = useAuth();
  const [config, setConfig] = useState<PartnerConfig | null>(null);
  const [prospects, setProspects] = useState<PartnerProspect[]>([]);
  const [partners, setPartners] = useState<PartnerActive[]>([]);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof partnerStats>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const [cfg, pros, parts, s] = await Promise.all([
        getPartnerConfig(user.id),
        listProspects(user.id, { limit: 50 }),
        listActivePartners(user.id),
        partnerStats(user.id),
      ]);
      setConfig(cfg);
      setProspects(pros);
      setPartners(parts);
      setStats(s);
    } catch (e) {
      toast.error('Erreur de chargement', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleToggle = async (next: boolean) => {
    if (!user || !config) return;
    if (next && (!config.sender_name || !config.sender_email)) {
      toast.error('Renseigne ton identité expéditeur dans les paramètres');
      return;
    }
    setSavingToggle(true);
    try {
      const updated = await updatePartnerConfig(user.id, { is_active: next });
      setConfig(updated);
      toast.success(next ? '🤖 Agent partenariat activé' : 'Agent en pause');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally { setSavingToggle(false); }
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent-cyan animate-spin" />
      </div>
    );
  }

  // Group prospects by pipeline column
  const byColumn: Record<string, PartnerProspect[]> = {};
  for (const col of PIPELINE_COLUMNS) byColumn[col.id] = [];
  for (const p of prospects) {
    const col = STATUS_META[p.status]?.column;
    if (col && byColumn[col]) byColumn[col].push(p);
  }

  const isConfigured = !!config.sender_email;
  const responseRate = stats && stats.emailsSent > 0
    ? Math.round((stats.emailsReplied / stats.emailsSent) * 100)
    : 0;

  const tutorialSteps: TutorialStep[] = [
    { selector: null, title: 'Bienvenue dans l\'Agent Partenariat 🤝', body: 'Trouve, contacte, signe et accompagne tes partenaires en continu. L\'IA fait tout : recherche Tavily, rédaction Claude, envoi Resend, contrats DocuSeal.' },
    { selector: null, title: 'Configure ton identité', body: 'Avant tout : ton nom d\'envoi, ton email, ton ton de communication, tes niches cibles.' },
    { selector: null, title: 'Trouve des prospects via IA', body: 'Décris en français le type de partenaire que tu veux. L\'IA cherche, analyse et score 0-100.' },
    { selector: null, title: 'Active l\'outreach automatique', body: 'L\'agent envoie 20 emails/jour personnalisés par défaut, dans tes plages horaires.' },
    { selector: null, title: 'Suis le pipeline visuel', body: 'Identifié → Contacté → Intéressé → Contrat → Actif. Tu vois tout en un coup d\'œil.' },
  ];

  return (
    <div className="space-y-8 max-w-6xl mx-auto pb-12">
      <TutorialOverlay storageKey="partner-agent" steps={tutorialSteps} />
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Handshake className="w-7 h-7 text-accent-cyan" />
            Agent Partenariat
            {config.is_active ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Actif</Badge>
            ) : (
              <Badge variant="secondary">En pause</Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Trouve, contacte, signe et accompagne tes partenaires en continu.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/partner-agent/settings">
            <Button variant="outline" size="sm">
              <Settings className="w-4 h-4 mr-2" /> Réglages
            </Button>
          </Link>
        </div>
      </motion.div>

      {!isConfigured && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Configure ton identité d'envoi</p>
                <p className="text-sm text-muted-foreground">
                  L'agent a besoin de ton nom, ton email et ton ton de communication avant d'envoyer le moindre email.
                </p>
              </div>
            </div>
            <Link to="/dashboard/partner-agent/settings">
              <Button>Configurer</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Toggle */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-accent-cyan/10 flex items-center justify-center">
              <Power className="w-6 h-6 text-accent-cyan" />
            </div>
            <div>
              <p className="font-semibold text-foreground">Activer l'agent</p>
              <p className="text-xs text-muted-foreground">
                Recherche quotidienne · {config.daily_outreach_limit} emails/jour max · relances {config.relance_1_delay_days}/{config.relance_2_delay_days}/{config.relance_3_delay_days}j
              </p>
            </div>
          </div>
          <Switch
            checked={config.is_active}
            onCheckedChange={handleToggle}
            disabled={savingToggle || !isConfigured}
          />
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Prospects', value: stats?.prospectsTotal ?? 0, icon: Inbox, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Emails envoyés', value: stats?.emailsSent ?? 0, icon: Send, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
          { label: 'Taux réponse', value: `${responseRate}%`, icon: TrendingUp, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
          { label: 'Partenaires actifs', value: stats?.partnersActive ?? 0, icon: Users, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
        ].map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className={`w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center mb-2`}>
                  <s.icon className={`w-4 h-4 ${s.color}`} />
                </div>
                <p className="text-xl font-orbitron font-bold text-foreground">{s.value}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QuickLink to="/dashboard/partner-agent/prospects" icon={Sparkles} label="Prospects" badge={stats?.prospectsContacted} badgeLabel="contactés" />
        <QuickLink to="/dashboard/partner-agent/partners" icon={Users} label="Partenaires" />
        <QuickLink to="/dashboard/partner-agent/emails" icon={Mail} label="Emails" />
        <QuickLink to="/dashboard/partner-agent/settings" icon={Settings} label="Réglages" />
      </div>

      {/* Pipeline Kanban */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-orbitron font-bold text-foreground">Pipeline</h2>
            <Link to="/dashboard/partner-agent/prospects" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              Tout voir <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 overflow-x-auto">
            {PIPELINE_COLUMNS.map(col => {
              const items = byColumn[col.id] ?? [];
              return (
                <div key={col.id} className="rounded-lg bg-secondary/20 border border-border p-3 min-w-[140px]">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-foreground">{col.label}</p>
                    <span className="text-[10px] text-muted-foreground">{items.length}</span>
                  </div>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {items.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground/60 italic">Vide</p>
                    ) : items.slice(0, 5).map(p => {
                      const meta = STATUS_META[p.status];
                      return (
                        <Link key={p.id} to="/dashboard/partner-agent/prospects" className="block p-2 rounded bg-card border border-border hover:border-accent-cyan/30">
                          <div className="flex items-start gap-1.5">
                            <span className="text-xs">{meta?.emoji ?? '•'}</span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[11px] font-medium text-foreground truncate">{p.name}</p>
                              {p.ai_score !== null && (
                                <p className="text-[9px] text-accent-purple">Score {p.ai_score}/100</p>
                              )}
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                    {items.length > 5 && (
                      <p className="text-[9px] text-muted-foreground text-center">+{items.length - 5}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Top partners */}
      {partners.length > 0 && (
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
                <DollarSign className="w-5 h-5 text-emerald-400" /> Top partenaires
              </h2>
            </div>
            <div className="space-y-2">
              {partners.slice(0, 5).map(p => (
                <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/20">
                  <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent-purple to-accent-cyan flex items-center justify-center text-sm font-bold text-foreground">
                    {p.partner_name[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{p.partner_name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {p.total_conversions} conv. · {p.total_clicks} clics · {p.level}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-orbitron font-bold text-emerald-400">{formatEUR(p.total_revenue_generated)}</p>
                    <p className="text-[10px] text-muted-foreground">{formatEUR(p.total_commission_earned)} comm.</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pending commissions */}
      {stats && stats.pendingCommissions > 0 && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-4 flex items-center gap-3">
            <DollarSign className="w-5 h-5 text-yellow-400 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-foreground">{formatEUR(stats.pendingCommissions)} de commissions en attente</p>
              <p className="text-[11px] text-muted-foreground">À payer aux partenaires</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Chat with the Partner Agent */}
      <AgentChatTab
        agentType="partner"
        agentName="Agent Partenariats"
        agentEmoji="🤝"
        agentColor="#A855F7"
        suggestions={[
          'Écris-moi un cold email pour un partenaire SaaS B2B',
          'Quels KPI suivre pour mon programme d\'affiliation ?',
          'Comment qualifier un lead en MEDDIC ?',
          'Propose une grille de commission pour des partenaires premium',
        ]}
      />
    </div>
  );
}

function QuickLink({
  to, icon: Icon, label, badge, badgeLabel,
}: {
  to: string;
  icon: typeof Handshake;
  label: string;
  badge?: number;
  badgeLabel?: string;
}) {
  return (
    <Link to={to}>
      <Card className="bg-card border-border hover:border-accent-cyan/30 transition-all h-full">
        <CardContent className="p-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
            <Icon className="w-4 h-4 text-accent-cyan" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{label}</p>
            {badge !== undefined && badge > 0 && (
              <p className="text-[11px] text-yellow-400">{badge} {badgeLabel}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

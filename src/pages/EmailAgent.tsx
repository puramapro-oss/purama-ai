import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Mail, Power, Settings, FileText, Activity, Inbox, Brain,
  Zap, Clock, Sparkles, ArrowRight, AlertCircle, CheckCircle2,
  Loader2, BookOpen, Users,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getConfig, updateConfig, listLogs, pendingDraftsCount,
  getGmailOAuthUrl,
  AUTONOMY_LEVELS, ACTION_META, CATEGORY_META,
  type EmailAgentConfig, type EmailAgentLog, type AutonomyLevel,
} from '@/lib/email-agent';

export default function EmailAgent() {
  const { user } = useAuth();
  const [config, setConfig] = useState<EmailAgentConfig | null>(null);
  const [logs, setLogs] = useState<EmailAgentLog[]>([]);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);
  const [savingLevel, setSavingLevel] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const [cfg, l, p] = await Promise.all([
        getConfig(user.id),
        listLogs(user.id, { limit: 12 }),
        pendingDraftsCount(user.id),
      ]);
      setConfig(cfg);
      setLogs(l);
      setPending(p);
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
    // Surface OAuth callback result.
    const params = new URLSearchParams(window.location.search);
    if (params.get('gmail') === 'connected') {
      toast.success('✅ Gmail connecté !');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('gmail') === 'error') {
      toast.error('Erreur lors de la connexion Gmail');
      window.history.replaceState({}, '', window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleToggleActive = async (next: boolean) => {
    if (!user || !config) return;
    if (next && !config.gmail_email) {
      toast.error('Connecte Gmail avant d\'activer l\'agent');
      return;
    }
    setSavingToggle(true);
    try {
      const updated = await updateConfig(user.id, { is_active: next });
      setConfig(updated);
      toast.success(next ? '🤖 Agent activé' : 'Agent en pause');
    } catch (e) {
      toast.error('Impossible de mettre à jour', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSavingToggle(false);
    }
  };

  const handleAutonomyChange = async (vals: number[]) => {
    if (!user || !config) return;
    const level = Math.max(1, Math.min(5, vals[0])) as AutonomyLevel;
    if (level === config.autonomy_level) return;
    setSavingLevel(true);
    try {
      const updated = await updateConfig(user.id, { autonomy_level: level });
      setConfig(updated);
    } catch (e) {
      toast.error('Erreur', {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSavingLevel(false);
    }
  };

  const handleConnectGmail = async () => {
    setConnecting(true);
    try {
      const url = await getGmailOAuthUrl();
      window.location.href = url;
    } catch (e) {
      toast.error('Impossible de démarrer la connexion Gmail', {
        description: e instanceof Error ? e.message : String(e),
      });
      setConnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent-cyan animate-spin" />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">Aucune configuration disponible</p>
      </div>
    );
  }

  const levelMeta = AUTONOMY_LEVELS[config.autonomy_level];
  const isConnected = !!config.gmail_email;

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-12">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Mail className="w-7 h-7 text-accent-cyan" />
            Agent Email
            {config.is_active ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                Actif
              </Badge>
            ) : (
              <Badge variant="secondary">En pause</Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Ton agent IA qui lit, trie et répond à tes emails 24/7.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/email-agent/settings">
            <Button variant="outline" size="sm">
              <Settings className="w-4 h-4 mr-2" />
              Réglages
            </Button>
          </Link>
        </div>
      </motion.div>

      {/* Gmail connection card */}
      {!isConnected && (
        <Card className="border-yellow-500/30 bg-yellow-500/5">
          <CardContent className="p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 justify-between">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-6 h-6 text-yellow-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-foreground">Connecte ta boîte Gmail</p>
                <p className="text-sm text-muted-foreground">
                  L'agent a besoin d'un accès Gmail pour lire et répondre à tes emails. Tes tokens sont chiffrés et tu peux révoquer l'accès à tout moment.
                </p>
              </div>
            </div>
            <Button onClick={handleConnectGmail} disabled={connecting}>
              {connecting ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Mail className="w-4 h-4 mr-2" />}
              Connecter Gmail
            </Button>
          </CardContent>
        </Card>
      )}

      {isConnected && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4 flex items-center gap-3 justify-between">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              <div>
                <p className="text-sm font-medium text-foreground">{config.gmail_email}</p>
                <p className="text-xs text-muted-foreground">
                  {config.last_sync_at
                    ? `Dernière synchro : ${new Date(config.last_sync_at).toLocaleString('fr-FR')}`
                    : 'En attente du premier scan…'}
                </p>
              </div>
            </div>
            <Link to="/dashboard/email-agent/settings">
              <Button variant="ghost" size="sm" className="text-xs">
                Gérer
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Master toggle + autonomy */}
      <Card className="bg-card border-border">
        <CardContent className="p-6 space-y-6">
          {/* On/off */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-2xl bg-accent-cyan/10 flex items-center justify-center">
                <Power className="w-6 h-6 text-accent-cyan" />
              </div>
              <div>
                <p className="font-semibold text-foreground">Activer l'agent</p>
                <p className="text-xs text-muted-foreground">
                  L'agent traite tes nouveaux emails toutes les 2 minutes.
                </p>
              </div>
            </div>
            <Switch
              checked={config.is_active}
              onCheckedChange={handleToggleActive}
              disabled={savingToggle || !isConnected}
            />
          </div>

          {/* Autonomy */}
          <div className="pt-4 border-t border-border space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-foreground flex items-center gap-2">
                  <Brain className="w-4 h-4 text-accent-purple" />
                  Niveau d'autonomie
                </p>
                <p className="text-xs text-muted-foreground">
                  Choisis combien tu laisses l'agent décider seul.
                </p>
              </div>
              <Badge className="bg-accent-purple/10 text-accent-purple border-accent-purple/20">
                Niveau {config.autonomy_level} — {levelMeta.label}
              </Badge>
            </div>
            <Slider
              value={[config.autonomy_level]}
              min={1}
              max={5}
              step={1}
              disabled={savingLevel}
              onValueChange={handleAutonomyChange}
            />
            <div className="grid grid-cols-5 gap-1 text-[10px] text-center text-muted-foreground">
              {([1, 2, 3, 4, 5] as AutonomyLevel[]).map(n => (
                <span key={n} className={n === config.autonomy_level ? 'text-accent-purple font-semibold' : ''}>
                  {AUTONOMY_LEVELS[n].emoji}
                </span>
              ))}
            </div>
            <div className="rounded-lg bg-secondary/30 border border-border p-3 text-xs text-muted-foreground">
              <span className="text-foreground font-medium">{levelMeta.emoji} {levelMeta.label}.</span>{' '}
              {levelMeta.description}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Traités', value: config.total_processed, icon: Inbox, color: 'text-accent-cyan', bg: 'bg-accent-cyan/10' },
          { label: 'Réponses auto', value: config.total_auto_replied, icon: Zap, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
          { label: 'Brouillons', value: config.total_drafted, icon: FileText, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
          { label: 'Temps gagné', value: `${Math.round(config.estimated_time_saved_minutes / 60)}h`, icon: Clock, color: 'text-accent-purple', bg: 'bg-accent-purple/10' },
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
        <QuickLink to="/dashboard/email-agent/logs" icon={Activity} label="Activité" badge={pending > 0 ? pending : undefined} badgeLabel="à valider" />
        <QuickLink to="/dashboard/email-agent/rules" icon={Sparkles} label="Règles" />
        <QuickLink to="/dashboard/email-agent/memory" icon={Users} label="Contacts" />
        <QuickLink to="/dashboard/email-agent/templates" icon={BookOpen} label="Templates" />
      </div>

      {/* Activity feed */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-orbitron font-bold text-foreground">Activité récente</h2>
            <Link to="/dashboard/email-agent/logs" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              Tout voir <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {logs.length === 0 ? (
            <div className="text-center py-10 text-sm text-muted-foreground">
              {config.is_active
                ? 'En attente de nouveaux emails…'
                : "L'agent est en pause. Active-le pour qu'il commence à traiter tes emails."}
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map(log => {
                const action = ACTION_META[log.action_taken] ?? ACTION_META.ignore;
                const cat = CATEGORY_META[log.category] ?? CATEGORY_META.normal;
                return (
                  <div
                    key={log.id}
                    className="flex items-start gap-3 p-3 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/40 transition-colors"
                  >
                    <div className="text-xl flex-shrink-0">{action.emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground truncate">
                          {log.from_name || log.from_email}
                        </span>
                        <Badge variant="outline" className="text-[10px] py-0 h-4">
                          {cat.emoji} {cat.label}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">
                        {log.subject || '(sans objet)'}
                      </p>
                      {log.ai_reasoning && (
                        <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate italic">
                          {log.ai_reasoning}
                        </p>
                      )}
                    </div>
                    <div className={`text-[11px] ${action.color} flex-shrink-0`}>
                      {action.label}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function QuickLink({
  to, icon: Icon, label, badge, badgeLabel,
}: {
  to: string;
  icon: typeof Mail;
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
            {badge !== undefined && (
              <p className="text-[11px] text-yellow-400">
                {badge} {badgeLabel}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Calculator, Power, Settings, FileText, TrendingUp, TrendingDown,
  AlertTriangle, Receipt, Loader2, ArrowRight, CalendarClock, Activity,
  CheckCircle2, AlertCircle, Sparkles, Heart, Inbox, Wallet,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { TutorialOverlay, type TutorialStep } from '@/components/shared/TutorialOverlay';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import {
  getComptaConfig, updateComptaConfig,
  listTransactions, listDeclarations,
  pendingDeclarationsCount, transactionStats,
  formatEUR, nextDeadlineLabel,
  DECLARATION_META, STATUS_META,
  type ComptaConfig, type ComptaTransaction, type ComptaDeclaration,
} from '@/lib/compta';
import { AgentChatTab } from '@/components/voice/AgentChatTab';

interface Stats {
  monthRevenue: number;
  monthExpense: number;
  monthTvaCollectee: number;
  monthTvaDeductible: number;
  pendingCategorization: number;
  anomalies: number;
}

export default function ComptaAgent() {
  const { user } = useAuth();
  const [config, setConfig] = useState<ComptaConfig | null>(null);
  const [transactions, setTransactions] = useState<ComptaTransaction[]>([]);
  const [declarations, setDeclarations] = useState<ComptaDeclaration[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);

  const refresh = async () => {
    if (!user) return;
    try {
      const [cfg, tx, decl, p, s] = await Promise.all([
        getComptaConfig(user.id),
        listTransactions(user.id, { limit: 8 }),
        listDeclarations(user.id),
        pendingDeclarationsCount(user.id),
        transactionStats(user.id),
      ]);
      setConfig(cfg);
      setTransactions(tx);
      setDeclarations(decl);
      setPending(p);
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
    if (next && !config.siren) {
      toast.error('Renseigne ton SIREN dans les paramètres avant d\'activer');
      return;
    }
    setSavingToggle(true);
    try {
      const updated = await updateComptaConfig(user.id, { is_active: next });
      setConfig(updated);
      toast.success(next ? '🤖 Agent compta activé' : 'Agent en pause');
    } catch (e) {
      toast.error('Erreur', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingToggle(false);
    }
  };

  if (loading || !config) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="w-8 h-8 text-accent-cyan animate-spin" />
      </div>
    );
  }

  const isConfigured = !!config.siren;
  const upcomingDeadlines = declarations
    .filter(d => d.status !== 'sent' && d.status !== 'confirmed')
    .slice(0, 4);
  const tvaNet = (stats?.monthTvaCollectee ?? 0) - (stats?.monthTvaDeductible ?? 0);

  const tutorialSteps: TutorialStep[] = [
    { selector: null, title: 'Bienvenue dans l\'Agent Comptable 🧾', body: 'Catégorisation IA, déclarations TVA/IS, factures Factur-X, recouvrement auto. Le module est inclus dans tous les plans, même Free.' },
    { selector: '[data-tuto="compta-config"]', title: 'Renseigne ton entreprise', body: 'SIREN, régime fiscal, régime TVA. C\'est la base pour que l\'IA catégorise correctement.' },
    { selector: '[data-tuto="compta-bridge"]', title: 'Connecte ta banque (Bridge)', body: 'L\'agent récupère tes transactions automatiquement toutes les 4h via Bridge (DSP2 conforme).' },
    { selector: '[data-tuto="compta-stats"]', title: 'Suis ta trésorerie temps réel', body: 'Recettes, dépenses, TVA nette. L\'IA détecte aussi les anomalies.' },
    { selector: '[data-tuto="compta-deadlines"]', title: 'Deadlines fiscales auto', body: 'L\'agent prépare TVA, IS, liasse, CFE 7 jours avant deadline. Tu valides en 1 tap.' },
  ];

  return (
    <div className="space-y-8 max-w-5xl mx-auto pb-12">
      <TutorialOverlay storageKey="compta-agent" steps={tutorialSteps} />
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex flex-col sm:flex-row sm:items-center gap-4 sm:justify-between"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-orbitron font-bold text-foreground flex items-center gap-3">
            <Calculator className="w-7 h-7 text-accent-cyan" />
            Agent Comptable
            {config.is_active ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">
                Actif
              </Badge>
            ) : (
              <Badge variant="secondary">En pause</Badge>
            )}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Catégorise tes transactions, calcule ta TVA, prépare tes déclarations 24/7.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/compta-agent/settings">
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
                <p className="font-semibold text-foreground">Renseigne ton entreprise</p>
                <p className="text-sm text-muted-foreground">
                  L'agent a besoin de ton SIREN, ton régime fiscal et ton régime TVA pour catégoriser correctement.
                </p>
              </div>
            </div>
            <Link to="/dashboard/compta-agent/settings" data-tuto="compta-config">
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
                Synchronisation toutes les 4h, déclarations 7j avant deadline.
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

      {/* Stats trésorerie */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3" data-tuto="compta-stats">
        {[
          {
            label: 'Recettes du mois',
            value: formatEUR(stats?.monthRevenue ?? 0),
            icon: TrendingUp,
            color: 'text-emerald-400',
            bg: 'bg-emerald-500/10',
          },
          {
            label: 'Dépenses du mois',
            value: formatEUR(stats?.monthExpense ?? 0),
            icon: TrendingDown,
            color: 'text-red-400',
            bg: 'bg-red-500/10',
          },
          {
            label: 'TVA nette du mois',
            value: formatEUR(tvaNet),
            icon: Receipt,
            color: 'text-accent-cyan',
            bg: 'bg-accent-cyan/10',
          },
          {
            label: 'À valider',
            value: pending,
            icon: AlertTriangle,
            color: 'text-yellow-400',
            bg: 'bg-yellow-500/10',
          },
        ].map((s, i) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className={`w-9 h-9 rounded-xl ${s.bg} flex items-center justify-center mb-2`}>
                  <s.icon className={`w-4 h-4 ${s.color}`} />
                </div>
                <p className="text-xl font-orbitron font-bold text-foreground truncate">{s.value}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <QuickLink to="/dashboard/compta-agent/transactions" icon={Inbox} label="Transactions" badge={stats?.pendingCategorization} badgeLabel="à valider" />
        <QuickLink to="/dashboard/compta-agent/invoices" icon={FileText} label="Factures" />
        <QuickLink to="/dashboard/compta-agent/declarations" icon={Receipt} label="Déclarations" badge={pending > 0 ? pending : undefined} badgeLabel="prêtes" />
        <QuickLink to="/dashboard/compta-agent/reports" icon={Activity} label="Rapports" />
      </div>

      {/* Score santé fiscale */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Heart className="w-5 h-5 text-accent-pink" />
              <h2 className="font-semibold text-foreground">Score santé fiscale</h2>
            </div>
            <span className="text-2xl font-orbitron font-bold text-foreground">
              {config.fiscal_health_score}<span className="text-sm text-muted-foreground">/100</span>
            </span>
          </div>
          <Progress value={config.fiscal_health_score} className="h-2" />
          <p className="text-[11px] text-muted-foreground mt-2">
            Mesuré sur la conformité, les optimisations fiscales activées et la régularité des déclarations.
          </p>
        </CardContent>
      </Card>

      {/* Deadlines */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
              <CalendarClock className="w-5 h-5 text-accent-purple" /> Prochaines échéances
            </h2>
            <Link to="/dashboard/compta-agent/declarations" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              Tout voir <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {upcomingDeadlines.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              Aucune déclaration en attente. Tout est à jour ✨
            </div>
          ) : (
            <div className="space-y-2">
              {upcomingDeadlines.map(d => {
                const meta = DECLARATION_META[d.type];
                const status = STATUS_META[d.status];
                return (
                  <Link
                    key={d.id}
                    to="/dashboard/compta-agent/declarations"
                    className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/20 hover:bg-secondary/40 transition-colors"
                  >
                    <div className="text-2xl flex-shrink-0">{meta.emoji}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-foreground">{meta.label}</span>
                        <span className="text-[11px] text-muted-foreground">{d.period}</span>
                      </div>
                      <p className={`text-[11px] ${status.color} mt-0.5`}>{status.label}</p>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className="text-xs font-medium text-foreground">{nextDeadlineLabel(d.deadline)}</p>
                      <p className="text-[10px] text-muted-foreground">{new Date(d.deadline).toLocaleDateString('fr-FR')}</p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Activité récente */}
      <Card className="bg-card border-border">
        <CardContent className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-orbitron font-bold text-foreground flex items-center gap-2">
              <Wallet className="w-5 h-5 text-accent-cyan" /> Dernières transactions
            </h2>
            <Link to="/dashboard/compta-agent/transactions" className="text-xs text-accent-cyan hover:underline flex items-center gap-1">
              Tout voir <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
          {transactions.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {config.is_active
                ? 'En attente de la première synchronisation Bridge…'
                : "Active l'agent pour démarrer la synchronisation bancaire."}
            </div>
          ) : (
            <div className="space-y-2">
              {transactions.map(tx => {
                const isCredit = (tx.type === 'credit') || tx.amount > 0;
                return (
                  <div key={tx.id} className="flex items-center gap-3 p-3 rounded-lg border border-border bg-secondary/20">
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${isCredit ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
                      {isCredit ? <TrendingUp className="w-4 h-4 text-emerald-400" /> : <TrendingDown className="w-4 h-4 text-red-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{tx.description}</p>
                      <div className="flex items-center gap-2 flex-wrap mt-0.5">
                        {tx.pcg_label && <Badge variant="outline" className="text-[10px] py-0 h-4">{tx.pcg_label}</Badge>}
                        {tx.tva_rate !== null && <span className="text-[10px] text-muted-foreground">TVA {tx.tva_rate}%</span>}
                        {tx.is_anomaly && <Badge className="bg-yellow-500/15 text-yellow-400 border-yellow-500/30 text-[10px]">⚠️ Anomalie</Badge>}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-semibold ${isCredit ? 'text-emerald-400' : 'text-foreground'}`}>
                        {isCredit ? '+' : ''}{formatEUR(tx.amount)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">{new Date(tx.date).toLocaleDateString('fr-FR')}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Chat with the Compta Agent */}
      <AgentChatTab
        agentType="compta"
        agentName="Agent Comptable"
        agentEmoji="📊"
        agentColor="#0EA5E9"
        suggestions={[
          'Calcule ma TVA collectée du mois',
          'Quelles sont mes obligations URSSAF en SASU ?',
          'Comment optimiser mon IS légalement ?',
          'Explique-moi la franchise art. 293B',
        ]}
      />
    </div>
  );
}

function QuickLink({
  to, icon: Icon, label, badge, badgeLabel,
}: {
  to: string;
  icon: typeof Calculator;
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

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Loader2,
  Power,
  ShieldAlert,
  FlaskConical,
  Clock,
  CheckCircle2,
  XCircle,
  PauseCircle,
  Activity,
  Sparkles,
  AlertTriangle,
  Check,
  X,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  useEmployeeAgents,
  useKartaAgentStates,
  useUpdateKartaAgentState,
  useKartaRuns,
  useKartaStats,
  usePendingActions,
  useResolvePendingAction,
  type ActionAgentSlug,
  type KartaRun,
  type KartaPendingAction,
} from '@/hooks/useKartaEmployees';

const AUTONOMY_LABELS: Record<number, string> = {
  1: 'Propose, tu valides',
  2: 'Agit seul (sauf sensible)',
  3: 'Autonomie totale',
};

const STATUS_META: Record<string, { label: string; icon: typeof CheckCircle2; className: string }> = {
  success: { label: 'Réussi', icon: CheckCircle2, className: 'text-accent-emerald' },
  error: { label: 'Erreur', icon: XCircle, className: 'text-destructive' },
  awaiting_approval: { label: 'En attente de validation', icon: PauseCircle, className: 'text-yellow-500' },
  running: { label: 'En cours', icon: Loader2, className: 'text-accent-cyan' },
  skipped: { label: 'Ignoré', icon: PauseCircle, className: 'text-muted-foreground' },
};

function formatRelative(iso: string | null) {
  if (!iso) return 'jamais';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Activity;
  label: string;
  value: string | number;
  hint?: string;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-accent-cyan/10 flex items-center justify-center flex-shrink-0">
          <Icon className="w-5 h-5 text-accent-cyan" />
        </div>
        <div className="min-w-0">
          <p className="text-xl font-bold text-foreground leading-none">{value}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
          {hint && <p className="text-[10px] text-muted-foreground/70">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function RunRow({ run, agentName, agentIcon }: { run: KartaRun; agentName: string; agentIcon: string }) {
  const meta = STATUS_META[run.status] ?? STATUS_META.running;
  const StatusIcon = meta.icon;

  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/50 last:border-0">
      <div className="w-9 h-9 rounded-full bg-secondary/60 flex items-center justify-center text-base flex-shrink-0">
        {agentIcon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{agentName}</span>
          <span className={`flex items-center gap-1 text-xs ${meta.className}`}>
            <StatusIcon className="w-3.5 h-3.5" /> {meta.label}
          </span>
          {run.claude_mock && (
            <Badge variant="outline" className="text-[10px] border-yellow-500/40 text-yellow-500">
              [MOCK] TODO_LIVE_TEST
            </Badge>
          )}
          {run.mode === 'simulation' && (
            <Badge variant="outline" className="text-[10px] border-accent-purple/40 text-accent-purple">
              Simulation
            </Badge>
          )}
        </div>
        {run.decision && (
          <p className="text-xs text-muted-foreground/90 mt-1 line-clamp-2">{run.decision}</p>
        )}
        {run.error_message && (
          <p className="text-xs text-destructive mt-1 line-clamp-2">{run.error_message}</p>
        )}
        <p className="text-[10px] text-muted-foreground/60 mt-1">
          {formatRelative(run.started_at)} · déclenché par {run.trigger_type}
        </p>
      </div>
    </div>
  );
}

function PendingActionCard({ action, agentName }: { action: KartaPendingAction; agentName: string }) {
  const resolve = useResolvePendingAction();

  const handle = (decision: 'approve' | 'reject') => {
    resolve.mutate(
      { pendingActionId: action.id, decision },
      {
        onSuccess: () => toast.success(decision === 'approve' ? 'Action exécutée' : 'Action rejetée'),
        onError: (e) => toast.error(e instanceof Error ? e.message : "Impossible de traiter cette action"),
      },
    );
  };

  return (
    <div className="flex items-start gap-3 py-3 border-b border-yellow-500/20 last:border-0">
      <PauseCircle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          {agentName} veut exécuter <span className="font-mono text-xs bg-secondary/60 px-1.5 py-0.5 rounded">{action.tool_name}</span>
        </p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">Demandé {formatRelative(action.created_at)}</p>
      </div>
      <div className="flex gap-2 flex-shrink-0">
        <Button
          size="sm"
          variant="outline"
          disabled={resolve.isPending}
          onClick={() => handle('reject')}
          className="border-destructive/30 text-destructive hover:bg-destructive/10"
        >
          <X className="w-3.5 h-3.5 mr-1" /> Rejeter
        </Button>
        <Button size="sm" disabled={resolve.isPending} onClick={() => handle('approve')}>
          <Check className="w-3.5 h-3.5 mr-1" /> Approuver
        </Button>
      </div>
    </div>
  );
}

interface EmployeeCardProps {
  slug: ActionAgentSlug;
  name: string;
  icon: string;
  category: string;
  description: string | null;
  state?: {
    is_enabled: boolean;
    autonomy_level: number;
    kill_switch: boolean;
    simulation_mode: boolean;
    last_run_at: string | null;
    last_run_status: string | null;
  };
}

function EmployeeCard({ slug, name, icon, category, description, state }: EmployeeCardProps) {
  const update = useUpdateKartaAgentState();

  const isEnabled = state?.is_enabled ?? false;
  const killSwitch = state?.kill_switch ?? false;
  const simulationMode = state?.simulation_mode ?? true;
  const autonomyLevel = state?.autonomy_level ?? 1;

  const statusLabel = killSwitch
    ? 'Arrêté (kill switch)'
    : !isEnabled
      ? 'Inactif'
      : simulationMode
        ? 'Actif — simulation'
        : 'Actif';

  const statusColor = killSwitch
    ? 'text-destructive'
    : !isEnabled
      ? 'text-muted-foreground'
      : simulationMode
        ? 'text-yellow-500'
        : 'text-accent-emerald';

  return (
    <Card className="bg-card border-border">
      <CardContent className="p-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-accent-cyan/10 flex items-center justify-center text-2xl flex-shrink-0">
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-orbitron font-bold text-foreground truncate">{name}</p>
            <p className="text-xs text-muted-foreground capitalize">{category}</p>
          </div>
          <Switch
            checked={isEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) =>
              update.mutate({ agentType: slug, patch: { is_enabled: checked } })
            }
          />
        </div>

        {description && <p className="text-xs text-muted-foreground/80 line-clamp-2">{description}</p>}

        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${statusColor}`}>● {statusLabel}</span>
        </div>

        <div>
          <p className="text-[11px] text-muted-foreground mb-1.5">Niveau d'autonomie</p>
          <div className="flex gap-1.5">
            {[1, 2, 3].map((level) => (
              <button
                key={level}
                disabled={update.isPending}
                onClick={() => update.mutate({ agentType: slug, patch: { autonomy_level: level } })}
                title={AUTONOMY_LABELS[level]}
                className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${
                  autonomyLevel === level
                    ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                    : 'bg-secondary/50 text-muted-foreground border border-transparent'
                }`}
              >
                {level}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-muted-foreground/70 mt-1">{AUTONOMY_LABELS[autonomyLevel]}</p>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <div className="flex items-center gap-1.5">
            <FlaskConical className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[11px] text-muted-foreground">Mode simulation (dry-run)</span>
          </div>
          <Switch
            checked={simulationMode}
            disabled={update.isPending}
            onCheckedChange={(checked) =>
              update.mutate({ agentType: slug, patch: { simulation_mode: checked } })
            }
          />
        </div>

        <button
          disabled={update.isPending}
          onClick={() => update.mutate({ agentType: slug, patch: { kill_switch: !killSwitch } })}
          className={`w-full flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-semibold transition-colors ${
            killSwitch
              ? 'bg-accent-emerald/10 text-accent-emerald hover:bg-accent-emerald/20'
              : 'bg-destructive/10 text-destructive hover:bg-destructive/20'
          }`}
        >
          {killSwitch ? (
            <>
              <Power className="w-3.5 h-3.5" /> Réactiver l'agent
            </>
          ) : (
            <>
              <ShieldAlert className="w-3.5 h-3.5" /> Arrêt d'urgence
            </>
          )}
        </button>

        <p className="text-[10px] text-muted-foreground/60 text-right">
          Dernière exécution : {formatRelative(state?.last_run_at ?? null)}
        </p>
      </CardContent>
    </Card>
  );
}

export default function MyEmployees() {
  const [tab, setTab] = useState<'equipe' | 'activite'>('equipe');
  const { data: agents = [], isLoading: agentsLoading, isError: agentsError } = useEmployeeAgents();
  const { data: statesMap, isLoading: statesLoading, isError: statesError } = useKartaAgentStates();
  const { data: runs = [], isLoading: runsLoading, isError: runsError } = useKartaRuns(30);
  const { data: pendingActions = [], isError: pendingError } = usePendingActions();
  const stats = useKartaStats();

  const isLoading = agentsLoading || statesLoading;
  const hasError = agentsError || statesError;

  const sortedAgents = useMemo(() => [...agents].sort((a, b) => a.name.localeCompare(b.name)), [agents]);

  const activeCount = sortedAgents.filter((a) => statesMap?.get(a.slug)?.is_enabled).length;

  const agentLookup = useMemo(() => {
    const map = new Map<string, { name: string; icon: string }>();
    agents.forEach((a) => map.set(a.slug, { name: a.name, icon: a.icon || '🤖' }));
    return map;
  }, [agents]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-orbitron font-bold text-foreground flex items-center gap-2">
          <Sparkles className="w-6 h-6 text-accent-cyan" /> Mes employés IA
        </h1>
        <p className="text-muted-foreground text-sm">
          {isLoading ? '…' : `${activeCount} actif${activeCount > 1 ? 's' : ''} sur ${sortedAgents.length}`} —
          activés par KARTA Engine, tes agents travaillent en autonomie selon les réglages ci-dessous.
        </p>
      </div>

      {hasError && (
        <Card className="bg-destructive/5 border-destructive/30">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-destructive flex-shrink-0" />
            <p className="text-sm text-destructive">
              Impossible de charger tes employés IA pour le moment. Vérifie ta connexion et recharge la page — si le
              problème persiste, contacte le support.
            </p>
          </CardContent>
        </Card>
      )}

      {!hasError && (
        <>
          {/* Stats réelles (30 derniers jours) */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard icon={Activity} label="Exécutions (30j)" value={stats.total} />
            <StatCard icon={CheckCircle2} label="Taux de réussite" value={`${stats.successRate}%`} />
            <StatCard icon={PauseCircle} label="En attente de validation" value={stats.awaitingApproval} />
            <StatCard icon={Clock} label="Dernière activité" value={formatRelative(runs[0]?.started_at ?? null)} />
          </div>

          {!pendingError && pendingActions.length > 0 && (
            <Card className="bg-yellow-500/5 border-yellow-500/30">
              <CardContent className="p-5">
                <p className="text-sm font-medium text-foreground mb-1">
                  {pendingActions.length} action{pendingActions.length > 1 ? 's' : ''} en attente de ta validation
                </p>
                {pendingActions.map((action) => (
                  <PendingActionCard
                    key={action.id}
                    action={action}
                    agentName={agentLookup.get(action.agent_type)?.name ?? action.agent_type}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Tabs */}
      <div className="flex gap-2">
        {[
          { key: 'equipe' as const, label: 'Mon équipe' },
          { key: 'activite' as const, label: "Timeline d'activité" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              tab === t.key
                ? 'bg-accent-cyan/20 text-accent-cyan border border-accent-cyan/30'
                : 'bg-secondary/50 text-muted-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && !hasError && (
        <div className="flex justify-center py-20">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      )}

      {!isLoading && !hasError && tab === 'equipe' && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {sortedAgents.map((agent, i) => (
            <motion.div
              key={agent.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.04, 0.4) }}
            >
              <EmployeeCard
                slug={agent.slug as ActionAgentSlug}
                name={agent.name}
                icon={agent.icon || '🤖'}
                category={agent.category}
                description={agent.description}
                state={statesMap?.get(agent.slug)}
              />
            </motion.div>
          ))}
        </div>
      )}

      {!isLoading && !hasError && tab === 'activite' && (
        <Card className="bg-card border-border">
          <CardContent className="p-5">
            {runsLoading && (
              <div className="flex justify-center py-10">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {runsError && (
              <p className="text-sm text-destructive text-center py-10">
                Impossible de charger l'historique d'activité pour le moment. Réessaie dans un instant.
              </p>
            )}
            {!runsLoading && !runsError && runs.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-10">
                Aucune exécution enregistrée pour le moment. Active un employé IA pour démarrer.
              </p>
            )}
            {!runsLoading &&
              !runsError &&
              runs.map((run) => (
                <RunRow
                  key={run.id}
                  run={run}
                  agentName={agentLookup.get(run.agent_type)?.name ?? run.agent_type}
                  agentIcon={agentLookup.get(run.agent_type)?.icon ?? '🤖'}
                />
              ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

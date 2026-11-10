import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { getKartaRunStatus } from '@/lib/karta-run-status';
import {
  useEmployeeAgents,
  useUpdateKartaAgentState,
  useTriggerKartaAgent,
  usePollLatestRun,
  type ActionAgentSlug,
  type KartaRunTracking,
} from '@/hooks/useKartaEmployees';

// Les 4 employés les plus simples à essayer : 0 connexion externe requise (Gmail OAuth...),
// juste de vraies données déjà présentes (factures, transactions, leads) — démo sans friction.
const ONBOARDING_SLUGS: ActionAgentSlug[] = [
  'crm-intelligent',
  'chasseur-de-paiements',
  'facture-pro',
  'rapports-financiers',
];

type Step = 'pick' | 'confirm' | 'working' | 'result';

export function HireFirstEmployeeModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { data: agents = [] } = useEmployeeAgents();
  const updateState = useUpdateKartaAgentState();
  const trigger = useTriggerKartaAgent();

  const [step, setStep] = useState<Step>('pick');
  const [selected, setSelected] = useState<ActionAgentSlug | null>(null);
  const [tracking, setTracking] = useState<KartaRunTracking | null>(null);
  const [trackingUnavailable, setTrackingUnavailable] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);
  const attemptGeneration = useRef(0);

  // Keep the request identity stable when showing its result, including when polling stops.
  // Clearing the key on the result step would also clear run.data and leave the modal empty.
  const run = usePollLatestRun(selected, tracking, open && !pollTimedOut && !trackingUnavailable);
  const runStatus = getKartaRunStatus(run.data);

  useEffect(() => {
    if (run.data && step === 'working' && (runStatus.phase === 'complete' || runStatus.phase === 'approval')) {
      setStep('result');
    }
  }, [run.data, runStatus.phase, step]);

  useEffect(() => {
    if (step !== 'working') return;
    const timeout = setTimeout(() => setPollTimedOut(true), 20000);
    return () => clearTimeout(timeout);
  }, [step]);

  const easyAgents = agents
    .filter((a) => ONBOARDING_SLUGS.includes(a.slug as ActionAgentSlug))
    .sort((a, b) => ONBOARDING_SLUGS.indexOf(a.slug as ActionAgentSlug) - ONBOARDING_SLUGS.indexOf(b.slug as ActionAgentSlug));

  const selectedAgent = agents.find((a) => a.slug === selected);

  const reset = useCallback(() => {
    attemptGeneration.current += 1;
    setStep('pick');
    setSelected(null);
    setTracking(null);
    setTrackingUnavailable(false);
    setTriggerError(null);
    setPollTimedOut(false);
  }, []);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  useEffect(() => () => { attemptGeneration.current += 1; }, []);

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleHire() {
    if (!selected) return;
    const generation = ++attemptGeneration.current;
    const attemptId = crypto.randomUUID();
    const agentType = selected;
    setTriggerError(null);
    setTracking(null);
    setTrackingUnavailable(false);
    setPollTimedOut(false);
    setStep('working');

    try {
      await updateState.mutateAsync({
        agentType,
        patch: { is_enabled: true, autonomy_level: 1, simulation_mode: true },
      });
      if (generation !== attemptGeneration.current) return;

      const queued = await trigger.mutateAsync(agentType);
      if (generation !== attemptGeneration.current) return;
      if (queued.executionKey) {
        setTracking({ attemptId, executionKey: queued.executionKey });
      } else {
        setTrackingUnavailable(true);
      }
    } catch (e) {
      if (generation !== attemptGeneration.current) return;
      setTriggerError(e instanceof Error ? e.message : 'Impossible de démarrer ton employé.');
      setStep('confirm');
    }
  }

  const needsFollowUp = trackingUnavailable || pollTimedOut || run.isError
    || (!!run.data && runStatus.phase === 'unknown');
  const WorkingIcon = needsFollowUp ? AlertTriangle : (run.data ? runStatus.icon : Loader2);
  const ResultIcon = runStatus.icon;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        {step === 'pick' && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-accent-cyan" /> Embauche ton premier employé IA
              </DialogTitle>
              <DialogDescription>
                Choisis un employé pour essayer une première tâche en simulation.
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {easyAgents.map((agent) => (
                <button
                  key={agent.slug}
                  onClick={() => {
                    setSelected(agent.slug as ActionAgentSlug);
                    setStep('confirm');
                  }}
                  className="flex flex-col items-center text-center gap-2 p-4 rounded-xl bg-secondary/40 border border-border hover:border-accent-cyan/40 hover:bg-secondary/60 transition-all"
                >
                  <span className="text-3xl">{agent.icon || '🤖'}</span>
                  <span className="text-sm font-semibold text-foreground">{agent.name}</span>
                  <span className="text-[11px] text-muted-foreground line-clamp-2">{agent.description}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'confirm' && selectedAgent && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <span className="text-2xl">{selectedAgent.icon || '🤖'}</span> Embaucher {selectedAgent.name}
              </DialogTitle>
              <DialogDescription>{selectedAgent.description}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="flex items-start gap-2 p-3 rounded-lg bg-accent-cyan/10 border border-accent-cyan/20">
                <ShieldCheck className="w-4 h-4 text-accent-cyan flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted-foreground">
                  La première tâche est une <strong className="text-foreground">simulation</strong>. Tu peux
                  examiner les propositions avant d’activer les actions réelles et arrêter l’employé à tout moment.
                </p>
              </div>
              {triggerError && <p className="text-xs text-destructive">{triggerError}</p>}
              <button
                onClick={handleHire}
                disabled={updateState.isPending || trigger.isPending}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-accent-cyan text-background font-semibold text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                Embaucher {selectedAgent.name} <ArrowRight className="w-4 h-4" />
              </button>
              <button
                onClick={() => setStep('pick')}
                className="w-full text-xs text-muted-foreground hover:text-foreground"
              >
                Choisir un autre employé
              </button>
            </div>
          </>
        )}

        {step === 'working' && selectedAgent && (
          <div role="status" className="flex flex-col items-center text-center py-8 gap-4">
            <WorkingIcon className={`w-10 h-10 ${needsFollowUp ? 'text-yellow-500' : 'text-accent-cyan animate-spin'}`} />
            <DialogHeader className="text-center">
              <DialogTitle className="text-base">
                {trackingUnavailable ? 'Suivi de la tâche indisponible'
                  : run.isError ? 'Impossible de vérifier le résultat'
                    : pollTimedOut ? 'La tâche prend plus de temps que prévu'
                      : run.data ? `${selectedAgent.name} ${runStatus.title}`
                        : tracking ? `${selectedAgent.name} va démarrer…` : `Démarrage de ${selectedAgent.name}…`}
              </DialogTitle>
              <DialogDescription>
                {trackingUnavailable || run.isError
                  ? 'Le résultat n’est pas confirmé. Consulte l’activité avant de lancer une autre tâche.'
                  : pollTimedOut ? 'L’attente est terminée ici. Consulte l’activité pour connaître le résultat avant de relancer la tâche.'
                    : run.data ? runStatus.description : 'La première simulation est en préparation.'}
              </DialogDescription>
            </DialogHeader>
            {needsFollowUp && (
              <button
                onClick={() => {
                  handleClose(false);
                  navigate('/dashboard/employees?tab=activite');
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-accent-cyan text-background font-semibold text-sm hover:opacity-90 transition-opacity"
              >
                Consulter l’activité <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        )}

        {step === 'result' && selectedAgent && run.data && (
          <>
            <DialogHeader>
              <DialogTitle className={`flex items-center gap-2 ${runStatus.className}`}>
                <ResultIcon className="w-5 h-5" /> {selectedAgent.name} {runStatus.title}
              </DialogTitle>
              <DialogDescription>{runStatus.label}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="p-3 rounded-lg bg-secondary/50 border border-border">
                <p className="text-sm text-foreground">
                  {run.data.error_message || run.data.result_summary || run.data.decision || runStatus.description}
                </p>
                {run.data.claude_mock && (
                  <Badge variant="outline" className="text-[10px] border-yellow-500/40 text-yellow-500 mt-2">
                    Mode démonstration
                  </Badge>
                )}
              </div>
              <button
                onClick={() => {
                  handleClose(false);
                  navigate('/dashboard/employees');
                }}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-accent-cyan text-background font-semibold text-sm hover:opacity-90 transition-opacity"
              >
                {runStatus.phase === 'approval' ? 'Voir les actions à valider' : 'Voir mon équipe'} <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

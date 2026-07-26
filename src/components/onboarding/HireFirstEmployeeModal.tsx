import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, CheckCircle2, Sparkles, ArrowRight, ShieldCheck } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import {
  useEmployeeAgents,
  useUpdateKartaAgentState,
  useTriggerKartaAgent,
  usePollLatestRun,
  type ActionAgentSlug,
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
  const [sinceIso, setSinceIso] = useState<string | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  const [pollTimedOut, setPollTimedOut] = useState(false);

  const run = usePollLatestRun(step === 'working' && !pollTimedOut ? selected : null, sinceIso);

  useEffect(() => {
    if (run.data && step === 'working') setStep('result');
  }, [run.data, step]);

  useEffect(() => {
    if (step !== 'working') return;
    const timeout = setTimeout(() => setPollTimedOut(true), 20000);
    return () => clearTimeout(timeout);
  }, [step]);

  const easyAgents = agents
    .filter((a) => ONBOARDING_SLUGS.includes(a.slug as ActionAgentSlug))
    .sort((a, b) => ONBOARDING_SLUGS.indexOf(a.slug as ActionAgentSlug) - ONBOARDING_SLUGS.indexOf(b.slug as ActionAgentSlug));

  const selectedAgent = agents.find((a) => a.slug === selected);

  function reset() {
    setStep('pick');
    setSelected(null);
    setSinceIso(null);
    setTriggerError(null);
    setPollTimedOut(false);
  }

  function handleClose(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleHire() {
    if (!selected) return;
    setTriggerError(null);
    setStep('working');

    try {
      await updateState.mutateAsync({
        agentType: selected,
        patch: { is_enabled: true, autonomy_level: 1, simulation_mode: true },
      });

      const now = new Date().toISOString();
      setSinceIso(now);
      await trigger.mutateAsync(selected);
    } catch (e) {
      setTriggerError(e instanceof Error ? e.message : 'Impossible de démarrer ton employé.');
      setStep('confirm');
    }
  }

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
                Choisis-en un pour commencer. Il travaille en 2 minutes, sans rien connecter.
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
                  Il te <strong className="text-foreground">propose</strong> ses actions, tu valides toujours avant
                  qu'il fasse quoi que ce soit — 100% sécurisé, désactivable à tout moment.
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

        {step === 'working' && selectedAgent && !pollTimedOut && (
          <div className="flex flex-col items-center text-center py-8 gap-4">
            <Loader2 className="w-10 h-10 text-accent-cyan animate-spin" />
            <div>
              <p className="font-semibold text-foreground">{selectedAgent.name} travaille…</p>
              <p className="text-xs text-muted-foreground mt-1">
                Première tâche en cours sur tes vraies données. Quelques secondes.
              </p>
            </div>
          </div>
        )}

        {step === 'working' && selectedAgent && pollTimedOut && (
          <div className="flex flex-col items-center text-center py-8 gap-4">
            <CheckCircle2 className="w-10 h-10 text-accent-emerald" />
            <div>
              <p className="font-semibold text-foreground">C'est parti — {selectedAgent.name} est embauché</p>
              <p className="text-xs text-muted-foreground mt-1">
                Sa première tâche prend un peu plus de temps que prévu. Retrouve le résultat dans
                ta timeline dès qu'il a terminé.
              </p>
            </div>
            <button
              onClick={() => {
                handleClose(false);
                navigate('/dashboard/employees');
              }}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-accent-cyan text-background font-semibold text-sm hover:opacity-90 transition-opacity"
            >
              Voir mon équipe <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {step === 'result' && selectedAgent && run.data && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-accent-emerald">
                <CheckCircle2 className="w-5 h-5" /> {selectedAgent.name} a terminé sa 1ère tâche
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="p-3 rounded-lg bg-secondary/50 border border-border">
                <p className="text-sm text-foreground">{run.data.decision || run.data.result_summary}</p>
                {run.data.claude_mock && (
                  <Badge variant="outline" className="text-[10px] border-yellow-500/40 text-yellow-500 mt-2">
                    [MOCK] TODO_LIVE_TEST — sera remplacé par une vraie décision Claude au lancement
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
                Voir mon équipe <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

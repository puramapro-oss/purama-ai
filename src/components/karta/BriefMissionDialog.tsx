import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import {
  BRIEF_MAX_LENGTH, BriefRequestError, useKartaBriefMissions, useKartaBriefStatus, useMutateKartaBrief,
  type BriefAgentSlug, type BriefMission, type BriefMutationInput, type BriefMutationResult,
} from '@/hooks/useKartaEmployees';
import { getKartaRunStatus } from '@/lib/karta-run-status';
import { formatRelative } from '@/lib/utils';

interface PendingDelivery {
  action: 'submit-brief' | 'retry-brief';
  submissionId: string;
  requestId: string;
}
interface BriefMissionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentType: BriefAgentSlug;
  agentName: string;
  isEnabled: boolean;
  killSwitch: boolean;
  simulationMode: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_WINDOW_MS = 30000;
const MISSION_LABELS: Record<BriefMission['state'], string> = {
  pending: 'Consigne en attente', claimed: 'Consigne prise en charge', effect_started: 'Traitement engagé',
  ready: 'Prête à reprendre', awaiting_approval: 'En attente de validation', completed: 'Consigne traitée',
  reconciliation_required: 'Vérification nécessaire',
};

function pendingKey(ownerId: string, agentType: BriefAgentSlug) {
  return `purama:karta-brief:v1:${ownerId}:${agentType}`;
}

function trackingKey(ownerId: string, agentType: BriefAgentSlug) {
  return `purama:karta-brief-tracking:v1:${ownerId}:${agentType}`;
}

function readTracking(key: string): string | null {
  try {
    const id = localStorage.getItem(key);
    return id && UUID.test(id) ? id : null;
  } catch { return null; }
}

function rememberTracking(key: string, submissionId: string): boolean {
  try { localStorage.setItem(key, submissionId); return true; }
  catch { return false; }
}

function rememberDelivery(key: string, delivery: PendingDelivery): boolean {
  try { localStorage.setItem(key, JSON.stringify(delivery)); return true; }
  catch { return false; }
}

/** Only identifiers are persisted. Neither the brief nor a token belongs in this record. */
function readPending(key: string): PendingDelivery | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (value && (value.action === 'submit-brief' || value.action === 'retry-brief')
      && typeof value.submissionId === 'string' && UUID.test(value.submissionId)
      && typeof value.requestId === 'string' && UUID.test(value.requestId)) {
      return { action: value.action, submissionId: value.submissionId, requestId: value.requestId };
    }
  } catch { /* The server list still recovers missions; a new write must save its identifiers first. */ }
  return null;
}

function forgetPending(key: string, delivery: PendingDelivery) {
  try {
    const current = readPending(key);
    if (current?.submissionId === delivery.submissionId && current.requestId === delivery.requestId) {
      localStorage.removeItem(key);
    }
  } catch { /* A retained identifier will be reconciled against the server on reopening. */ }
}

/** Keyed by the authenticated owner: changing accounts destroys draft, polling and in-flight UI state. */
export function BriefMissionDialog(props: BriefMissionDialogProps) {
  const { user } = useAuth();
  if (!props.open || !user) return null;
  return <BriefMissionSession key={`${user.id}:${props.agentType}`} {...props} ownerId={user.id} />;
}

function BriefMissionSession({ ownerId, agentType, agentName, onOpenChange, isEnabled, killSwitch, simulationMode }: BriefMissionDialogProps & { ownerId: string }) {
  const navigate = useNavigate();
  const storageKey = pendingKey(ownerId, agentType);
  const trackingStorageKey = trackingKey(ownerId, agentType);
  const [pending, setPending] = useState<PendingDelivery | null>(() => readPending(storageKey));
  const [trackedSubmissionId, setTrackedSubmissionId] = useState<string | null>(() => readTracking(trackingStorageKey));
  const [draft, setDraft] = useState('');
  const [frozenBrief, setFrozenBrief] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasConflict, setHasConflict] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [polling, setPolling] = useState(true);
  const [pollGeneration, setPollGeneration] = useState(0);
  const [recoveredMission, setRecoveredMission] = useState<BriefMission | null>(null);
  const [lastDispatch, setLastDispatch] = useState<{ submissionId: string; state: BriefMutationResult['dispatch']['state'] } | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const requestController = useRef<AbortController | null>(null);
  const missionsQuery = useKartaBriefMissions(agentType, polling);
  const refetchMissions = missionsQuery.refetch;
  const listedMissions = missionsQuery.data ?? [];
  const statusId = pending?.submissionId ?? (trackedSubmissionId
    && !listedMissions.some(mission => mission.submissionId === trackedSubmissionId) ? trackedSubmissionId : null);
  const statusQuery = useKartaBriefStatus(agentType, statusId, polling);
  const mutation = useMutateKartaBrief();
  const individuallyTracked = statusQuery.data ?? recoveredMission;
  // The server list is bounded. Keep an individually recovered mission visible after removing
  // its uncertain-delivery record, even when it is older than the twenty listed missions.
  const missions = individuallyTracked && !listedMissions.some(mission => mission.submissionId === individuallyTracked.submissionId)
    ? [individuallyTracked, ...listedMissions] : listedMissions;
  const recovered = pending && (statusQuery.data ?? listedMissions.find(mission => mission.submissionId === pending.submissionId));
  const hasPendingSlot = missions.some(mission => mission.state === 'pending');
  const text = frozenBrief ?? draft.trim();
  const invalidCharacter = text.includes('\0');
  const invalidText = !text || invalidCharacter || text.length > BRIEF_MAX_LENGTH || new TextEncoder().encode(text).length > 32000;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; requestController.current?.abort(); };
  }, []);

  useEffect(() => {
    setPolling(true);
    const timeout = setTimeout(() => setPolling(false), POLL_WINDOW_MS);
    return () => clearTimeout(timeout);
  }, [pollGeneration]);

  // Admission does not prove dispatch. A recovered pending/ready mission retains the original
  // requestId as a retry without text; polling never starts a mutation. A rejected new draft
  // stays visible until the user explicitly discards it, even if the old mission is recovered.
  useEffect(() => {
    if (!pending || !recovered || mutation.isPending || dispatching) return;
    setRecoveredMission(recovered);
    setTrackedSubmissionId(recovered.submissionId);
    if (!rememberTracking(trackingStorageKey, recovered.submissionId)) {
      setStorageError('Le suivi est visible ici, mais sa référence n’a pas pu être conservée sur cet appareil.');
    }
    if (hasConflict) return;
    if (recovered.state === 'pending' || recovered.state === 'ready') {
      if (pending.action === 'retry-brief') return;
      const retryDelivery: PendingDelivery = { ...pending, action: 'retry-brief' };
      if (!rememberDelivery(storageKey, retryDelivery)) {
        setStorageError('La référence du lancement n’a pas pu être mise à jour sur cet appareil.');
      }
      setPending(retryDelivery);
    } else {
      forgetPending(storageKey, pending);
      setPending(null);
    }
    setFrozenBrief(null);
    setDraft('');
    setError(null);
    setLastDispatch({ submissionId: recovered.submissionId, state: 'unconfirmed' });
    void refetchMissions();
  }, [pending, recovered, mutation.isPending, dispatching, storageKey, trackingStorageKey, hasConflict, refetchMissions]);

  function refresh() {
    setPollGeneration(value => value + 1);
    void missionsQuery.refetch();
    if (statusId) void statusQuery.refetch();
  }

  async function dispatch(delivery: PendingDelivery, brief?: string) {
    if (inFlight.current) return;
    const existing = readPending(storageKey);
    if (existing && (existing.submissionId !== delivery.submissionId || existing.requestId !== delivery.requestId)) {
      setPending(existing);
      setFrozenBrief(null);
      setDraft('');
      setError('Un autre envoi attend une vérification. Consulte son suivi avant de continuer.');
      return;
    }
    if (!rememberDelivery(storageKey, delivery)) {
      setError('Impossible de conserver la référence de cet envoi sur cet appareil. Vérifie que le stockage du navigateur est disponible.');
      return;
    }
    inFlight.current = true;
    setDispatching(true);
    setPending(delivery);
    if (delivery.action === 'submit-brief') setFrozenBrief(brief!);
    setError(null);
    setHasConflict(false);
    setPollGeneration(value => value + 1);
    const controller = new AbortController();
    requestController.current = controller;
    const request: BriefMutationInput = delivery.action === 'submit-brief'
      ? { ...delivery, action: 'submit-brief', agentType, brief: brief! }
      : { ...delivery, action: 'retry-brief', agentType };
    try {
      const result = await mutation.mutateAsync({ request, signal: controller.signal });
      if (!alive.current) return;
      setRecoveredMission(result.mission);
      setTrackedSubmissionId(result.mission.submissionId);
      if (!rememberTracking(trackingStorageKey, result.mission.submissionId)) {
        setStorageError('Le suivi est visible ici, mais sa référence n’a pas pu être conservée sur cet appareil.');
      }
      if (result.dispatch.state === 'unconfirmed') {
        const retryDelivery: PendingDelivery = { ...delivery, action: 'retry-brief' };
        if (!rememberDelivery(storageKey, retryDelivery)) {
          setStorageError('La référence du lancement n’a pas pu être mise à jour sur cet appareil.');
        }
        setPending(retryDelivery);
      } else {
        forgetPending(storageKey, delivery);
        setPending(null);
      }
      setFrozenBrief(null);
      setDraft('');
      setLastDispatch({ submissionId: result.mission.submissionId, state: result.dispatch.state });
    } catch (failure) {
      if (!alive.current) return;
      setError(failure instanceof BriefRequestError ? failure.message : 'Impossible de confirmer cet envoi. Vérifie le suivi avant de continuer.');
      if (failure instanceof BriefRequestError && failure.code === 'BRIEF_CONFLICT') setHasConflict(true);
      if (failure instanceof BriefRequestError && (failure.code === 'BRIEF_BUSY' || failure.code === 'INVALID')) {
        // A confirmed rejection did not replace the pending slot. Keep the user's draft editable.
        forgetPending(storageKey, delivery);
        setPending(null);
        setFrozenBrief(null);
      }
      void missionsQuery.refetch();
    } finally {
      inFlight.current = false;
      if (alive.current) setDispatching(false);
      if (requestController.current === controller) requestController.current = null;
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (invalidText || hasConflict || mutation.isPending || missionsQuery.isLoading || missionsQuery.isError
      || (pending && pending.action !== 'submit-brief') || (!pending && hasPendingSlot)) return;
    const delivery = pending ?? { action: 'submit-brief' as const, submissionId: crypto.randomUUID(), requestId: crypto.randomUUID() };
    void dispatch(delivery, text);
  }

  function retry(mission: BriefMission) {
    if (pending || mutation.isPending || !isEnabled || killSwitch
      || (mission.state !== 'pending' && mission.state !== 'ready')) return;
    void dispatch({ action: 'retry-brief', submissionId: mission.submissionId, requestId: crypto.randomUUID() });
  }

  function viewActivity(approvals = false) {
    onOpenChange(false);
    navigate(approvals ? '/dashboard/employees' : '/dashboard/employees?tab=activite');
  }

  function discardConflictingDraft() {
    setDraft('');
    setFrozenBrief(null);
    setError(null);
    setHasConflict(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Donner une mission à {agentName}</DialogTitle>
          <DialogDescription>Écris une consigne précise. Son enregistrement et son traitement sont suivis ici.</DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {killSwitch ? 'L’arrêt d’urgence est actif. La consigne peut être enregistrée ; le traitement attend la réactivation de l’employé.'
            : !isEnabled ? 'Cet employé est inactif. Active-le dans sa fiche pour traiter la consigne enregistrée.'
              : simulationMode ? 'Mode simulation : un aperçu est préparé et la consigne reste en attente.'
                : 'Les actions respectent le niveau d’autonomie et les validations de cet employé.'}
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`brief-${agentType}`}>Ta consigne</Label>
            <Textarea id={`brief-${agentType}`} value={frozenBrief ?? draft}
              onChange={event => setDraft(event.target.value)} maxLength={BRIEF_MAX_LENGTH}
              disabled={mutation.isPending || (!hasConflict && frozenBrief !== null) || pending?.action === 'retry-brief'}
              readOnly={frozenBrief !== null || hasConflict}
              aria-describedby={`brief-help-${agentType}`} rows={5}
              placeholder="Décris l’objectif, les destinataires, les contraintes et le résultat attendu." />
            <p id={`brief-help-${agentType}`} className="text-xs text-muted-foreground">
              {(frozenBrief ?? draft).length} / {BRIEF_MAX_LENGTH} caractères.
              {pending?.action === 'submit-brief' && frozenBrief === null
                ? ' Pour reprendre un envoi non confirmé, ressaisis exactement la consigne d’origine ; sa référence est conservée.'
                : frozenBrief !== null ? ' La consigne reste identique tant que son enregistrement n’est pas confirmé.' : ''}
            </p>
          </div>
          {invalidCharacter && <p role="alert" className="text-sm text-destructive">La consigne contient un caractère non autorisé. Retire-le avant de l’enregistrer.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {hasConflict && <div className="space-y-2 rounded-lg border border-destructive/30 p-3 text-sm">
            <p>Le texte ressaisi n’a pas remplacé la mission d’origine. Il reste affiché pour que tu puisses le conserver.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={discardConflictingDraft}>Abandonner le texte ressaisi</Button>
              {recovered && <Button type="button" variant="outline"
                onClick={() => document.getElementById(`brief-mission-${recovered.submissionId}`)?.scrollIntoView({ block: 'nearest' })}>
                Consulter la mission d’origine
              </Button>}
            </div>
          </div>}
          {hasPendingSlot && !pending && <p className="text-sm text-muted-foreground">Une consigne attend déjà cet employé. Elle sera conservée.</p>}
          <Button type="submit" className="w-full"
            disabled={invalidText || hasConflict || mutation.isPending || missionsQuery.isLoading || missionsQuery.isError
              || pending?.action === 'retry-brief' || (!pending && hasPendingSlot)}>
            {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {pending?.action === 'submit-brief' ? 'Réessayer le même envoi' : 'Enregistrer la mission'}
          </Button>
        </form>

        {pending && !mutation.isPending && (
          <div role="status" className="space-y-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3 text-sm">
            <p>{pending.action === 'submit-brief' ? 'Enregistrement à vérifier' : 'Lancement à vérifier'}</p>
            <p className="text-muted-foreground">Une réponse manquante ne signifie pas que la demande a échoué. Le suivi conserve sa référence.</p>
            {pending.action === 'retry-brief' && <Button variant="outline" disabled={mutation.isPending || !isEnabled || killSwitch}
              onClick={() => void dispatch(pending)}>Réessayer le même lancement</Button>}
          </div>
        )}

        <section className="space-y-3" aria-label="Suivi des missions">
          {storageError && <p role="alert" className="text-sm text-destructive">{storageError}</p>}
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Missions enregistrées</h2>
            <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={missionsQuery.isFetching || statusQuery.isFetching}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Actualiser le suivi
            </Button>
          </div>
          {missionsQuery.isLoading && <p role="status" className="text-sm text-muted-foreground">Chargement des missions…</p>}
          {(missionsQuery.isError || statusQuery.isError) && <p role="alert" className="text-sm text-destructive">Impossible de vérifier les missions pour le moment. Actualise le suivi avant un nouvel envoi.</p>}
          {!polling && <p role="status" className="text-xs text-muted-foreground">Le suivi automatique est en pause. Actualise pour vérifier les changements ; aucune mission n’est relancée.</p>}
          {!missionsQuery.isLoading && !missionsQuery.isError && missions.length === 0 && <p className="text-sm text-muted-foreground">Aucune mission enregistrée pour cet employé.</p>}
          {missions.map(mission => {
            const runStatus = mission.run ? getKartaRunStatus(mission.run) : null;
            const retryable = mission.state === 'pending' || mission.state === 'ready';
            const dispatchState = lastDispatch?.submissionId === mission.submissionId ? lastDispatch.state : null;
            return (
              <article key={mission.submissionId} id={`brief-mission-${mission.submissionId}`} className="space-y-2 rounded-lg border border-border p-3" aria-label={`Mission ${mission.submissionId.slice(0, 8)}`}>
                {hasConflict && pending?.submissionId === mission.submissionId && <p className="text-sm font-semibold">Mission d’origine — le texte ressaisi a été refusé</p>}
                <p className="text-sm font-medium">{MISSION_LABELS[mission.state]}</p>
                <p className="text-xs text-muted-foreground">Enregistrée {formatRelative(mission.createdAt)} · {mission.attemptCount} tentative{mission.attemptCount > 1 ? 's' : ''}</p>
                {runStatus && <p className={`text-sm ${runStatus.className}`}>Dernière exécution : {runStatus.label}</p>}
                {mission.run?.mode === 'simulation' && <p className="text-sm text-muted-foreground">La simulation ne consomme pas la consigne. Elle reste disponible pour un traitement réel.</p>}
                {mission.run?.mock && <Badge variant="outline">Mode démonstration</Badge>}
                {dispatchState === 'queued' && retryable && <p className="text-sm text-muted-foreground">Le lancement a été accepté. Le résultat reste à confirmer.</p>}
                {dispatchState === 'unconfirmed' && retryable && <p className="text-sm text-muted-foreground">Consigne enregistrée. Le lancement n’est pas encore confirmé.</p>}
                {dispatchState === 'not_requested' && retryable && <p className="text-sm text-muted-foreground">Consigne enregistrée. Aucun nouveau lancement n’a été demandé.</p>}
                {mission.state === 'reconciliation_required' && <p className="text-sm text-muted-foreground">Le résultat demande une vérification dans l’activité. Cette mission ne peut pas être relancée ici.</p>}
                {retryable && <Button variant="outline" size="sm" disabled={!!pending || mutation.isPending || !isEnabled || killSwitch
                  || (dispatchState === 'queued' && polling)} onClick={() => retry(mission)}>Reprendre cette mission</Button>}
                {mission.state === 'awaiting_approval' && <Button variant="outline" size="sm" onClick={() => viewActivity(true)}>Voir les actions à valider</Button>}
              </article>
            );
          })}
          <Button variant="ghost" onClick={() => viewActivity()}>Consulter l’activité</Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}

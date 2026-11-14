import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, CheckCircle2, Code2, Copy, Download, Eye, Layers3, Loader2, RefreshCw, Square, Wand2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import {
  consumeWorkshopDraft, isMissionRunning, isMissionTerminal, requestWorkshop, requestWorkshopArtifact, workshopPreviewDocument,
  type MissionState, type TaskState, type WorkshopArtifact, type WorkshopDetail, type WorkshopMission, type WorkshopProject,
} from '@/lib/workshop';

const missionLabels: Record<MissionState, string> = {
  planning: 'Préparation', active: 'En attente ou en cours', paused: 'En pause',
  human_required: 'Décision nécessaire', external_required: 'Dépendance indisponible',
  verified_done: 'Résultat vérifié', failed: 'Échec à résoudre', cancelled: 'Arrêt confirmé',
  cancelling: 'Arrêt demandé',
};
const taskLabels: Record<TaskState, string> = {
  pending: 'En attente des étapes précédentes', ready: 'Prête à démarrer', claimed: 'Prise en charge',
  running: 'En cours', verifying: 'Vérification', retryable: 'Nouvel essai prévu',
  blocked_human: 'Décision nécessaire', blocked_external: 'Dépendance indisponible',
  verified_done: 'Vérifiée', failed: 'Échec', cancelled: 'Annulée',
};
const formatDate = (value: string) => new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const message = (error: unknown) => error instanceof Error ? error.message : 'L’atelier est momentanément indisponible.';
const isAbort = (error: unknown) => error instanceof Error && error.name === 'AbortError';

function CommitReference({ sha }: { sha: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    <code className="min-w-0 break-all">{sha}</code>
    <button type="button" aria-label="Copier la référence du résultat" className="shrink-0 rounded p-2 hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      onClick={async () => {
        try { await navigator.clipboard.writeText(sha); setCopied(true); setFailed(false); }
        catch { setFailed(true); }
      }}>
      {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
    </button>
    {failed && <span role="status">Sélectionnez la référence pour la copier.</span>}
  </div>;
}

function WorkshopResult({ mission }: { mission: WorkshopDetail }) {
  const [artifact, setArtifact] = useState<WorkshopArtifact | null>(null);
  const [archiveUrl, setArchiveUrl] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSize, setPreviewSize] = useState<'desktop' | 'tablet' | 'mobile'>('desktop');
  const request = useRef<AbortController | null>(null);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!artifact) return;
    const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.archive.data).buffer], { type: 'application/zip' }));
    setArchiveUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [artifact]);
  const load = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setError('');
    setLoading(true);
    try {
      const result = await requestWorkshopArtifact(mission, controller.signal);
      if (alive.current && !controller.signal.aborted) setArtifact(result);
    } catch (failure) {
      if (alive.current && !controller.signal.aborted && !isAbort(failure)) setError(message(failure));
    } finally {
      if (request.current === controller) request.current = null;
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  };
  return <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-5" data-testid="workshop-result">
    <h4 className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> Création vérifiée</h4>
    <p className="mt-2 text-sm text-muted-foreground">Consultez le résultat ou téléchargez les fichiers de cette version.</p>
    {!artifact && <button type="button" onClick={() => void load()} disabled={loading} aria-busy={loading}
      className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-secondary disabled:opacity-60">
      {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Download className="h-4 w-4" aria-hidden="true" />}
      {loading ? 'Vérification des fichiers…' : error ? 'Réessayer les fichiers' : 'Accéder aux fichiers'}
    </button>}
    {error && <p role="alert" className="mt-3 text-sm text-amber-700 dark:text-amber-300">{error}</p>}
    {artifact && <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-3">
        {archiveUrl && <a href={archiveUrl} download={artifact.archive.fileName} className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90">
          <Download className="h-4 w-4" aria-hidden="true" /> Télécharger les sources ZIP
        </a>}
        {artifact.preview && <button type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen(open => !open)}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 py-2 text-sm font-semibold hover:bg-secondary">
          <Eye className="h-4 w-4" aria-hidden="true" /> {previewOpen ? 'Fermer l’aperçu' : 'Afficher l’aperçu'}
        </button>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">Archive des sources de cette version. La publication et les applications mobiles nécessitent leur propre validation.</p>
      <CommitReference sha={artifact.commitSha} />
      {!artifact.preview && <p className="text-sm text-muted-foreground">Les fichiers sont disponibles. Aucun aperçu HTML autonome n’est associé à cette version.</p>}
      {artifact.preview && previewOpen && <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Taille de l’aperçu">
          {(['desktop', 'tablet', 'mobile'] as const).map(size => <button type="button" key={size} aria-pressed={previewSize === size} onClick={() => setPreviewSize(size)}
            className={'min-h-11 rounded-lg border px-3 py-2 text-xs font-medium ' + (previewSize === size ? 'border-primary bg-primary/10' : 'border-border bg-background')}>
            {{ desktop: 'Ordinateur', tablet: 'Tablette', mobile: 'Mobile' }[size]}
          </button>)}
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-secondary p-1">
          <iframe title="Aperçu isolé de votre création" sandbox="allow-scripts" referrerPolicy="no-referrer"
            allow="camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; clipboard-read 'none'; clipboard-write 'none'"
            srcDoc={workshopPreviewDocument(artifact.preview.content)}
            style={{ width: previewSize === 'desktop' ? '100%' : previewSize === 'tablet' ? 768 : 375, maxWidth: '100%' }}
            className="mx-auto block h-[520px] border-0 bg-white" />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">L’aperçu est isolé de votre compte. Les ressources et services externes peuvent être bloqués dans cette vue.</p>
      </div>}
    </div>}
  </div>;
}

/** Remounting for a new principal also aborts every request owned by the old account. */
export default function Workshop() {
  const { user } = useAuth();
  return user ? <WorkshopSession key={user.id} userId={user.id} /> : null;
}

function WorkshopSession({ userId }: { userId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState('');
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<WorkshopProject[]>([]);
  const [missions, setMissions] = useState<WorkshopMission[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mission, setMission] = useState<WorkshopDetail | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [mutationError, setMutationError] = useState('');
  const [pending, setPending] = useState<'start' | 'cancel' | null>(null);
  const [listRevision, setListRevision] = useState(0);
  const [statusRevision, setStatusRevision] = useState(0);
  const mounted = useRef(false);
  const draftRead = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const statusController = useRef<AbortController | null>(null);
  const operation = useRef(false);
  const statusGeneration = useRef(0);
  const requestKey = useRef<{ projectId: string; prompt: string; id: string } | null>(null);

  const newController = () => {
    const controller = new AbortController();
    controllers.current.add(controller);
    return controller;
  };
  useEffect(() => {
    const pendingControllers = controllers.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingControllers.forEach(controller => controller.abort());
      pendingControllers.clear();
    };
  }, []);
  useEffect(() => {
    if (draftRead.current) return;
    draftRead.current = true;
    const draft = consumeWorkshopDraft(userId);
    const routed = typeof location.state?.workshopPrompt === 'string' ? location.state.workshopPrompt.slice(0, 6000) : '';
    setPrompt(draft || routed);
    if (routed) navigate(location.pathname, { replace: true, state: null });
  }, [userId, location.pathname, location.state, navigate]);

  useEffect(() => {
    const controller = newController();
    const pendingControllers = controllers.current;
    setListLoading(true);
    setListError('');
    void requestWorkshop({ action: 'list' }, controller.signal).then(result => {
      if (controller.signal.aborted || !mounted.current) return;
      setProjects(result.projects);
      setMissions(result.missions);
      setProjectId(previous => result.projects.some(project => project.id === previous) ? previous
        : result.projects.find(project => project.ready)?.id ?? result.projects[0]?.id ?? '');
      setSelectedId(previous => previous ?? result.missions[0]?.id ?? null);
    }).catch(error => {
      if (!controller.signal.aborted && mounted.current && !isAbort(error)) setListError(message(error));
    }).finally(() => {
      pendingControllers.delete(controller);
      if (!controller.signal.aborted && mounted.current) setListLoading(false);
    });
    return () => { controller.abort(); pendingControllers.delete(controller); };
  }, [listRevision]);

  useEffect(() => {
    if (!selectedId) return;
    const generation = ++statusGeneration.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      if (!active || !mounted.current || operation.current) return;
      const controller = newController();
      statusController.current = controller;
      setStatusLoading(true);
      try {
        const result = await requestWorkshop({ action: 'status', missionId: selectedId }, controller.signal);
        if (!active || controller.signal.aborted || !mounted.current || generation !== statusGeneration.current) return;
        if (result.id !== selectedId) throw new Error('La réponse ne correspond pas à la mission demandée.');
        setMission(result);
        setStatusError('');
        setMissions(previous => [result, ...previous.filter(item => item.id !== result.id)]
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
        if (isMissionRunning(result.state)) timer = setTimeout(() => void load(), 3000);
      } catch (error) {
        if (active && !controller.signal.aborted && mounted.current && generation === statusGeneration.current && !isAbort(error)) {
          setStatusError(message(error));
        }
      } finally {
        controllers.current.delete(controller);
        if (active && !controller.signal.aborted && mounted.current && generation === statusGeneration.current) setStatusLoading(false);
      }
    };
    void load();
    return () => { active = false; clearTimeout(timer); statusController.current?.abort(); };
  }, [selectedId, statusRevision]);

  const applyMission = (result: WorkshopDetail) => {
    setMission(result);
    setSelectedId(result.id);
    setMissions(previous => [result, ...previous.filter(item => item.id !== result.id)]);
  };
  const start = async (event: FormEvent) => {
    event.preventDefault();
    const goal = prompt.trim();
    const project = projects.find(item => item.id === projectId);
    if (operation.current || !project?.ready || listLoading || goal.length < 20 || goal.length > 6000) return;
    operation.current = true;
    setPending('start');
    setMutationError('');
    statusController.current?.abort();
    ++statusGeneration.current;
    if (!requestKey.current || requestKey.current.projectId !== projectId || requestKey.current.prompt !== goal) {
      requestKey.current = { projectId, prompt: goal, id: crypto.randomUUID() };
    }
    const controller = newController();
    try {
      const result = await requestWorkshop({ action: 'start', projectId, prompt: goal, requestId: requestKey.current.id }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (result.projectId !== projectId) throw new Error('La réponse ne correspond pas au projet demandé.');
      applyMission(result);
      requestKey.current = null;
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && !isAbort(error)) setMutationError(message(error));
    } finally {
      controllers.current.delete(controller);
      operation.current = false;
      if (mounted.current && !controller.signal.aborted) {
        setPending(null);
        setStatusRevision(value => value + 1);
      }
    }
  };
  const cancel = async () => {
    if (!mission || isMissionTerminal(mission.state) || mission.state === 'cancelling' || operation.current) return;
    const id = mission.id;
    operation.current = true;
    setPending('cancel');
    setMutationError('');
    statusController.current?.abort();
    ++statusGeneration.current;
    const controller = newController();
    try {
      const result = await requestWorkshop({ action: 'cancel', missionId: id }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (result.id !== id) throw new Error('La réponse ne correspond pas à la mission demandée.');
      applyMission(result);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && !isAbort(error)) setMutationError(message(error));
    } finally {
      controllers.current.delete(controller);
      operation.current = false;
      if (mounted.current && !controller.signal.aborted) {
        setPending(null);
        setStatusRevision(value => value + 1);
      }
    }
  };
  const chooseMission = (id: string) => {
    if (operation.current || id === selectedId) return;
    statusController.current?.abort();
    ++statusGeneration.current;
    setMission(null);
    setStatusError('');
    setMutationError('');
    setSelectedId(id);
  };
  const selectedProject = projects.find(project => project.id === projectId);
  const activeTasks = mission?.tasks.filter(task => ['claimed', 'running', 'verifying'].includes(task.state)) ?? [];
  const currentLabel = mission && mission.state === 'active' && activeTasks.length ? 'Agents au travail' : mission && missionLabels[mission.state];
  const canStart = !!selectedProject?.ready && !listLoading && !pending && prompt.trim().length >= 20;

  return <div className="mx-auto max-w-7xl space-y-7 px-1 py-3 sm:px-3 sm:py-6">
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="max-w-2xl">
        <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-accent-cyan"><Layers3 className="h-4 w-4" aria-hidden="true" /> IAO · Atelier de création</p>
        <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Votre idée. Une équipe pour la construire.</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">Décrivez votre site ou votre application. Suivez le travail des agents et retrouvez les résultats après leur vérification.</p>
      </div>
      <button type="button" onClick={() => { setListRevision(value => value + 1); setStatusRevision(value => value + 1); }}
        disabled={!!pending || listLoading} className="flex shrink-0 items-center justify-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm hover:bg-secondary disabled:opacity-50">
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Actualiser
      </button>
    </header>

    {(listError || mutationError) && <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-foreground">{mutationError || listError}</div>}

    <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)]">
      <div className="space-y-5">
        <form onSubmit={start} className="space-y-5 rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-center gap-3"><span className="rounded-xl bg-accent-cyan/10 p-2.5 text-accent-cyan"><Wand2 className="h-5 w-5" aria-hidden="true" /></span><h2 className="text-lg font-semibold">Nouvelle création</h2></div>
          <div>
            <label htmlFor="workshop-project" className="mb-2 block text-sm font-medium">Projet</label>
            <select id="workshop-project" value={projectId} onChange={event => { setProjectId(event.target.value); setMutationError(''); }} disabled={!!pending || listLoading || !projects.length}
              className="w-full rounded-xl border border-border bg-background px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60">
              {!projects.length && <option value="">{listLoading ? 'Chargement des projets…' : 'Aucun projet disponible'}</option>}
              {projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.ready ? '' : ' · indisponible'}</option>)}
            </select>
            {selectedProject?.ready && <p className="mt-2 text-xs text-muted-foreground">Jusqu’à {selectedProject.maxParallel} agent{selectedProject.maxParallel > 1 ? 's' : ''} simultané{selectedProject.maxParallel > 1 ? 's' : ''}, selon les étapes à réaliser.</p>}
            {!listLoading && !listError && !projects.length && <p className="mt-3 text-sm text-muted-foreground">Aucun espace de création n’est encore disponible pour ce compte. Vos missions existantes restent consultables.</p>}
            {selectedProject && !selectedProject.ready && <p className="mt-3 text-sm text-amber-600 dark:text-amber-300" role="status">{selectedProject.unavailableReason || 'Les agents de ce projet ne sont pas disponibles actuellement.'}</p>}
          </div>
          <div>
            <label htmlFor="workshop-goal" className="mb-2 block text-sm font-medium">Que voulez-vous créer ou améliorer ?</label>
            <textarea id="workshop-goal" value={prompt} onChange={event => setPrompt(event.target.value)} minLength={20} maxLength={6000} rows={7} disabled={!!pending}
              aria-describedby="workshop-goal-help" placeholder="Un site pour mon restaurant, avec le menu, une réservation et une expérience soignée sur mobile…"
              className="w-full resize-y rounded-xl border border-border bg-background px-4 py-3 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60" />
            <p id="workshop-goal-help" className="mt-2 flex justify-between gap-3 text-xs text-muted-foreground"><span>Précisez les fonctions et le résultat attendu. 20 caractères minimum.</span><span className="shrink-0">{prompt.length}/6 000</span></p>
          </div>
          <button type="submit" disabled={!canStart} aria-busy={pending === 'start'} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {pending === 'start' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Wand2 className="h-4 w-4" aria-hidden="true" />}
            {pending === 'start' ? 'Envoi de la mission…' : 'Lancer la création'}
          </button>
          <p className="text-xs leading-relaxed text-muted-foreground">Chaque étape est contrôlée avant d’être marquée comme vérifiée. La publication reste une action distincte.</p>
        </form>

        <section className="rounded-2xl border border-border bg-card p-5" aria-labelledby="workshop-history">
          <div className="mb-4 flex items-center justify-between"><h2 id="workshop-history" className="text-lg font-semibold">Vos missions</h2><span className="text-xs text-muted-foreground">{missions.length}</span></div>
          {listLoading && !missions.length ? <p className="text-sm text-muted-foreground" role="status">Chargement des missions…</p>
            : !missions.length ? <p className="text-sm text-muted-foreground">Vos créations apparaîtront ici. Vous pourrez reprendre leur suivi à tout moment.</p>
              : <ul className="max-h-80 space-y-2 overflow-y-auto">{missions.map(item => <li key={item.id}>
                <button type="button" disabled={!!pending} onClick={() => chooseMission(item.id)} aria-pressed={selectedId === item.id}
                  className={'w-full rounded-xl border p-3 text-left transition disabled:opacity-60 ' + (selectedId === item.id ? 'border-primary/40 bg-primary/5' : 'border-transparent hover:bg-secondary')}>
                  <span className="line-clamp-2 block break-words text-sm font-medium">{item.title}</span>
                  <span className="mt-1.5 block text-xs text-muted-foreground">{missionLabels[item.state]} · {formatDate(item.createdAt)}</span>
                </button>
              </li>)}</ul>}
        </section>
      </div>

      <section className={"min-w-0 rounded-2xl border border-border bg-card p-5 sm:p-6 " + (selectedId ? "order-first xl:order-none" : "")} aria-labelledby="workshop-followup">
        <div className="mb-6 flex items-center justify-between gap-3"><h2 id="workshop-followup" className="text-lg font-semibold">Suivi de la création</h2>
          {statusLoading && <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Mise à jour</span>}
        </div>
        {statusError && <div role="alert" className="mb-5 rounded-xl border border-amber-500/30 p-4 text-sm"><p>{statusError}</p>{mission && <p className="mt-2 text-xs text-muted-foreground">Dernier état connu affiché ci-dessous.</p>}
          <button type="button" onClick={() => setStatusRevision(value => value + 1)} className="mt-2 font-medium text-primary underline">Réessayer le suivi</button></div>}
        {!mission ? <div className="flex min-h-80 flex-col items-center justify-center px-4 text-center">
          <div className="mb-5 rounded-2xl bg-secondary p-5"><Code2 className="h-8 w-8 text-muted-foreground" aria-hidden="true" /></div>
          <p className="font-medium">{selectedId ? 'Récupération de la mission' : 'Tout commence par votre idée'}</p>
          <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">{selectedId ? 'Les étapes s’afficheront dès réception de leur état.' : 'Lancez une création ou sélectionnez une mission pour suivre ses étapes, ses agents et ses vérifications.'}</p>
        </div> : <div className="space-y-6">
          <div>
            <span className={'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ' + (mission.state === 'verified_done' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'bg-secondary text-foreground')}>
              {mission.state === 'verified_done' && <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />}{currentLabel}
            </span>
            <h3 className="mt-3 break-words text-xl font-semibold leading-snug">{mission.title}</h3>
            <p className="mt-2 text-xs text-muted-foreground">État enregistré le {formatDate(mission.updatedAt)}</p>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border p-3"><p className="text-xl font-semibold">{mission.verifiedTasks}<span className="text-sm text-muted-foreground">/{mission.totalTasks}</span></p><p className="mt-1 text-xs text-muted-foreground">étapes vérifiées</p></div>
            <div className="rounded-xl border border-border p-3"><p className="text-xl font-semibold">{activeTasks.length}</p><p className="mt-1 text-xs text-muted-foreground">étapes prises en charge</p></div>
            <div className="col-span-2 rounded-xl border border-border p-3 sm:col-span-1"><p className="text-xl font-semibold">{mission.usage.tokens.toLocaleString('fr-FR')}</p><p className="mt-1 text-xs text-muted-foreground">tokens comptabilisés</p></div>
          </div>
          <ol className="space-y-3">{mission.tasks.map((task, index) => <li key={task.id} className="rounded-xl border border-border p-4">
            <div className="flex items-start gap-3">
              <span className={'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-semibold ' + (task.state === 'verified_done' ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' : 'bg-secondary text-muted-foreground')}>
                {task.state === 'verified_done' ? <Check className="h-4 w-4" aria-hidden="true" /> : index + 1}
              </span>
              <div className="min-w-0 flex-1"><h4 className="break-words text-sm font-medium">{task.title}</h4><p className="mt-1 text-xs text-muted-foreground">{taskLabels[task.state]}{task.provider ? ' · ' + task.provider : ''}{task.attempt > 0 ? ' · essai ' + task.attempt : ''}</p>
                <p className="mt-2 text-xs text-muted-foreground">{task.evidenceCount} preuve{task.evidenceCount === 1 ? '' : 's'} enregistrée{task.evidenceCount === 1 ? '' : 's'}</p>
                {task.state === 'verified_done' && task.outputSha && <CommitReference sha={task.outputSha} />}
              </div>
            </div>
          </li>)}</ol>
          {mission.state === 'verified_done' && <WorkshopResult key={mission.id + ':' + mission.tasks.find(task => task.key === 'implementation')?.outputSha} mission={mission} />}
          {mission.state === 'cancelling' && <p role="status" className="text-sm text-muted-foreground">L’arrêt a été demandé. Le suivi reste actif jusqu’à sa confirmation par les agents.</p>}
          {!isMissionTerminal(mission.state) && mission.state !== 'cancelling' && <button type="button" onClick={() => void cancel()} disabled={!!pending} aria-busy={pending === 'cancel'}
            className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2.5 text-sm hover:bg-secondary disabled:opacity-50">
            {pending === 'cancel' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Square className="h-3.5 w-3.5" aria-hidden="true" />}
            {pending === 'cancel' ? 'Demande d’arrêt…' : 'Arrêter cette mission'}
          </button>}
        </div>}
      </section>
    </div>
  </div>;
}

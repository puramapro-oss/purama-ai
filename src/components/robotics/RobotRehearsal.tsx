import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RobotRoutineEditor } from './RobotRoutineEditor';
import { compileRoutineDraft, draftFromRoutine, newRoutineDraft, type RoutineDraft } from '@/lib/robot-routines';
import { RobotSessionPreview, type PreviewStatus } from '../../../karta/src/robotics/preview';
import { parseRobotRoutineJson, prepareRobotRoutine, ROUTINE_FILE_MAX_BYTES, serializeRobotRoutine } from '../../../karta/src/robotics/routines';

const statusLabels: Record<PreviewStatus, string> = {
  idle: 'Prêt pour un aperçu', running: 'Aperçu en cours', paused: 'Aperçu en pause',
  stopped: 'Aperçu arrêté', completed: 'Aperçu terminé',
};

export function RobotRehearsal() {
  const [controller] = useState(() => new RobotSessionPreview());
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  const [draft, setDraft] = useState(newRoutineDraft);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importState = useRef({ version: 0, inFlight: false });
  const downloadUrls = useRef(new Map<string, number>());
  const active = snapshot.status === 'running' || snapshot.status === 'paused';

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setSnapshot(controller.tick()), 100);
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') setSnapshot(controller.pause());
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', pauseWhenHidden);
    };
  }, [active, controller]);

  useEffect(() => {
    const urls = downloadUrls.current;
    const imports = importState.current;
    return () => {
      controller.stop();
      imports.version++;
      for (const [url, timer] of urls) { window.clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    };
  }, [controller]);

  const updateDraft = (next: RoutineDraft) => {
    if (active || importState.current.inFlight) return;
    setSnapshot(controller.reset());
    setDraft(next);
    setError(null);
    setNotice(null);
  };

  const start = () => {
    if (active || importState.current.inFlight) return;
    setError(null);
    setNotice(null);
    const now = Date.now();
    try {
      const session = prepareRobotRoutine(compileRoutineDraft(draft), {
        sessionId: `preview-${now}`, targetId: 'purama-simulator', now,
      });
      setSnapshot(controller.start(session, now));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de préparer cet aperçu.');
    }
  };

  const importRoutine = async (file: File | undefined) => {
    if (!file || active || importState.current.inFlight) return;
    const version = ++importState.current.version;
    importState.current.inFlight = true;
    setImporting(true);
    setError(null);
    setNotice(null);
    try {
      if (file.size > ROUTINE_FILE_MAX_BYTES) throw new Error('Fichier trop volumineux : limite de 512 000 octets.');
      const routine = parseRobotRoutineJson(await file.text());
      if (version !== importState.current.version) return;
      setSnapshot(controller.reset());
      setDraft(draftFromRoutine(routine));
      setNotice('Routine importée. Vérifiez les étapes avant de lancer un aperçu.');
    } catch (failure) {
      if (version === importState.current.version) {
        setError(`${failure instanceof Error ? failure.message : 'Lecture du fichier impossible.'} Votre routine actuelle est conservée.`);
      }
    } finally {
      if (version === importState.current.version) {
        importState.current.inFlight = false;
        setImporting(false);
      }
    }
  };

  const exportRoutine = () => {
    if (active || importState.current.inFlight) return;
    setError(null);
    setNotice(null);
    try {
      const text = serializeRobotRoutine(compileRoutineDraft(draft));
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
      const timer = window.setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.current.delete(url); }, 1000);
      downloadUrls.current.set(url, timer);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'purama-routine.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setNotice('Fichier préparé pour le téléchargement.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de préparer le fichier.');
    }
  };

  return (
    <section aria-labelledby="rehearsal-title" className="rounded-2xl border border-primary/30 bg-card p-5 sm:p-6 space-y-5">
      <div>
        <h2 id="rehearsal-title" className="text-xl font-semibold">Préparer une séance</h2>
        <p className="text-sm text-muted-foreground mt-1">Aperçu visuel uniquement : aucun son émis, aucun mouvement envoyé.</p>
      </div>
      <RobotRoutineEditor draft={draft} disabled={active || importing} onChange={updateDraft} />
      <fieldset disabled={active || importing} className="min-w-0 space-y-3 disabled:opacity-60">
        <legend className="sr-only">Fichier de routine</legend>
        <p className="text-sm text-muted-foreground">Exportez votre routine pour la réutiliser. Sans export, quitter cet écran efface vos modifications. L'import remplace la routine après validation et ne lance rien.</p>
        <label className="block space-y-2 text-sm font-medium">Importer une routine PURAMA
          <input type="file" accept=".json,application/json" className="block w-full min-w-0 text-sm file:mr-2 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-2 file:text-foreground"
            onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void importRoutine(file); }} />
        </label>
        <Button type="button" variant="outline" onClick={exportRoutine}>Exporter la routine</Button>
      </fieldset>
      {(importing || notice) && <p role="status" className="text-sm text-muted-foreground">{importing ? 'Lecture et validation du fichier…' : notice}</p>}
      {(error || snapshot.error) && <p id="robot-preview-error" role="alert" className="text-sm text-red-500">{error || snapshot.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={start} disabled={active || importing}><Play className="mr-2 h-4 w-4" />Lancer l'aperçu</Button>
        {snapshot.status === 'running' && <Button variant="outline" onClick={() => setSnapshot(controller.pause())}><Pause className="mr-2 h-4 w-4" />Mettre en pause</Button>}
        {snapshot.status === 'paused' && <Button variant="outline" onClick={() => setSnapshot(controller.resume())}><Play className="mr-2 h-4 w-4" />Reprendre</Button>}
        {active && <Button variant="outline" onClick={() => setSnapshot(controller.stop())}><Square className="mr-2 h-4 w-4" />Arrêter l'aperçu</Button>}
      </div>
      <div className="rounded-xl bg-secondary/40 p-4 space-y-3">
        <p role="status" className="font-medium">{statusLabels[snapshot.status]}</p>
        <progress aria-label="Progression de l'aperçu" value={snapshot.elapsedMs} max={snapshot.totalDurationMs || 1} className="w-full h-2 accent-cyan-400" />
        <p className="text-sm text-muted-foreground">{(snapshot.elapsedMs / 1000).toFixed(1)} / {snapshot.totalDurationMs / 1000} secondes</p>
        <p data-testid="robot-active-step" className="text-sm break-words">
          {snapshot.activeStep?.kind === 'speech' ? snapshot.activeStep.text
            : snapshot.activeStep?.kind === 'gesture' ? `Geste prévu : ${snapshot.activeStep.gesture === 'greeting' ? 'saluer' : "marquer l'attention"}`
              : snapshot.activeStep?.kind === 'pause' ? 'Temps de pause' : 'Aucune étape en cours'}
        </p>
      </div>
    </section>
  );
}

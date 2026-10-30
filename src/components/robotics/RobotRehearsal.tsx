import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RobotSessionPreview, type PreviewStatus } from '../../../karta/src/robotics/preview';

const statusLabels: Record<PreviewStatus, string> = {
  idle: 'Prêt pour un aperçu', running: 'Aperçu en cours', paused: 'Aperçu en pause',
  stopped: 'Aperçu arrêté', completed: 'Aperçu terminé',
};

export function RobotRehearsal() {
  const [controller] = useState(() => new RobotSessionPreview());
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  const [text, setText] = useState('Bienvenue. Prenez un instant pour vous installer confortablement.');
  const [speechSeconds, setSpeechSeconds] = useState('5');
  const [pauseSeconds, setPauseSeconds] = useState('3');
  const [gesture, setGesture] = useState('greeting');
  const [error, setError] = useState<string | null>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
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

  useEffect(() => () => { controller.stop(); }, [controller]);

  const start = () => {
    setError(null);
    if (!text.trim()) {
      setError('Ajoutez un texte avant de lancer la séance.');
      textInput.current?.focus();
      return;
    }
    const now = Date.now();
    try {
      setSnapshot(controller.start({
        version: 1, sessionId: `preview-${now}`, targetId: 'purama-simulator', expiresAt: now + 300_000,
        steps: [
          { id: 'speech', kind: 'speech', text, durationMs: Number(speechSeconds) * 1_000 },
          ...(gesture === 'none' ? [] : [{ id: 'gesture', kind: 'gesture', gesture, durationMs: 2_000 }]),
          { id: 'pause', kind: 'pause', durationMs: Number(pauseSeconds) * 1_000 },
        ],
      }, now));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Impossible de préparer cet aperçu.');
    }
  };

  return (
    <section aria-labelledby="rehearsal-title" className="rounded-2xl border border-primary/30 bg-card p-5 sm:p-6 space-y-5">
      <div>
        <h2 id="rehearsal-title" className="text-xl font-semibold">Préparer une séance</h2>
        <p className="text-sm text-muted-foreground mt-1">Aperçu visuel uniquement : aucun son émis, aucun mouvement envoyé.</p>
      </div>
      <fieldset disabled={active} className="space-y-4 disabled:opacity-60">
        <div className="space-y-2">
          <label htmlFor="robot-speech" className="text-sm font-medium">Texte de la séance</label>
          <textarea id="robot-speech" ref={textInput} value={text} maxLength={2000} rows={3}
            onChange={(event) => setText(event.target.value)} aria-describedby={error ? 'robot-preview-error' : undefined}
            className="w-full rounded-lg border border-input bg-background p-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" />
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="space-y-2 text-sm font-medium">Parole (secondes)
            <input aria-label="Durée de parole en secondes" type="number" min={1} max={60} step={1} value={speechSeconds}
              onChange={(event) => setSpeechSeconds(event.target.value)} className="block w-full rounded-lg border border-input bg-background p-2" />
          </label>
          <label className="space-y-2 text-sm font-medium">Geste à prévoir
            <select aria-label="Geste à prévoir" value={gesture} onChange={(event) => setGesture(event.target.value)} className="block w-full rounded-lg border border-input bg-background p-2">
              <option value="greeting">Saluer</option><option value="attention">Marquer l'attention</option><option value="none">Aucun geste</option>
            </select>
          </label>
          <label className="space-y-2 text-sm font-medium">Pause (secondes)
            <input aria-label="Durée de pause en secondes" type="number" min={1} max={60} step={1} value={pauseSeconds}
              onChange={(event) => setPauseSeconds(event.target.value)} className="block w-full rounded-lg border border-input bg-background p-2" />
          </label>
        </div>
      </fieldset>
      {(error || snapshot.error) && <p id="robot-preview-error" role="alert" className="text-sm text-red-500">{error || snapshot.error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={start} disabled={active}><Play className="mr-2 h-4 w-4" />Lancer l'aperçu</Button>
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

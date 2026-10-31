import { useId } from 'react';
import { Button } from '@/components/ui/button';
import { newDraftStep, type RoutineDraft, type RoutineDraftStep } from '@/lib/robot-routines';
import { SESSION_LIMITS, type SessionStep } from '../../../karta/src/robotics/session';

const kindLabels: Record<SessionStep['kind'], string> = { speech: 'Parole', gesture: 'Geste', pause: 'Pause' };
const fieldClass = 'block w-full min-w-0 rounded-lg border border-input bg-background p-2 text-sm';

export function RobotRoutineEditor({ draft, disabled, onChange }: {
  draft: RoutineDraft; disabled: boolean; onChange: (draft: RoutineDraft) => void;
}) {
  const editorId = useId();
  const updateStep = (index: number, patch: Partial<RoutineDraftStep>) => {
    onChange({ ...draft, steps: draft.steps.map((step, position) => position === index ? { ...step, ...patch } : step) });
  };
  const moveStep = (index: number, direction: -1 | 1) => {
    const destination = index + direction;
    if (destination < 0 || destination >= draft.steps.length) return;
    const steps = [...draft.steps];
    [steps[index], steps[destination]] = [steps[destination], steps[index]];
    onChange({ ...draft, steps });
  };
  const addStep = (kind: SessionStep['kind']) => {
    if (draft.steps.length < SESSION_LIMITS.steps) {
      onChange({ ...draft, steps: [...draft.steps, newDraftStep(kind, draft.steps)] });
    }
  };

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4 disabled:opacity-60">
      <legend className="sr-only">Éditeur de routine</legend>
      <label className="block space-y-2 text-sm font-medium">Nom de la routine
        <input value={draft.name} maxLength={120} onChange={event => onChange({ ...draft, name: event.target.value })} className={fieldClass} />
      </label>
      <p className="text-sm text-muted-foreground">{draft.steps.length} / {SESSION_LIMITS.steps} étapes · 5 minutes maximum au total. Chaque étape dure de 0,001 à 60 secondes.</p>
      <ol aria-label="Étapes de la routine" className="space-y-3">
        {draft.steps.map((step, index) => (
          <li key={step.id} className="min-w-0 rounded-xl border border-border p-3 space-y-3">
            <p className="text-sm font-semibold">{index + 1}. {kindLabels[step.kind]}</p>
            {step.kind === 'speech' && <div className="space-y-2 text-sm">
              <label htmlFor={`${editorId}-${step.id}-text`}>Texte étape {index + 1}</label>
              <textarea id={`${editorId}-${step.id}-text`} rows={3} value={step.text} maxLength={SESSION_LIMITS.textCharacters}
                onChange={event => updateStep(index, { text: event.target.value })} className={fieldClass} />
            </div>}
            {step.kind === 'gesture' && <div className="space-y-2 text-sm">
              <label htmlFor={`${editorId}-${step.id}-gesture`}>Geste étape {index + 1}</label>
              <select id={`${editorId}-${step.id}-gesture`} value={step.gesture} onChange={event => updateStep(index, { gesture: event.target.value as 'greeting' | 'attention' })} className={fieldClass}>
                <option value="greeting">Saluer</option><option value="attention">Marquer l'attention</option>
              </select>
            </div>}
            <div className="space-y-2 text-sm">
              <label htmlFor={`${editorId}-${step.id}-duration`}>Durée étape {index + 1} en secondes</label>
              <input id={`${editorId}-${step.id}-duration`} type="number" min={0.001} max={60} step={0.001} value={step.seconds}
                onChange={event => updateStep(index, { seconds: event.target.value })} className={fieldClass} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" aria-label={`Monter étape ${index + 1}`} disabled={index === 0} onClick={() => moveStep(index, -1)}>Monter</Button>
              <Button type="button" size="sm" variant="outline" aria-label={`Descendre étape ${index + 1}`} disabled={index === draft.steps.length - 1} onClick={() => moveStep(index, 1)}>Descendre</Button>
              <Button type="button" size="sm" variant="outline" aria-label={`Supprimer étape ${index + 1}`} disabled={draft.steps.length === 1}
                onClick={() => onChange({ ...draft, steps: draft.steps.filter((_, position) => position !== index) })}>Supprimer</Button>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {(['speech', 'gesture', 'pause'] as const).map(kind => (
          <Button key={kind} type="button" variant="outline" size="sm" disabled={draft.steps.length >= SESSION_LIMITS.steps} onClick={() => addStep(kind)}>
            Ajouter : {kindLabels[kind].toLowerCase()}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

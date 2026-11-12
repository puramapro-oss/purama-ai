import { parseRobotRoutine, ROUTINE_FORMAT, type RobotRoutine } from '../../karta/src/robotics/routines';
import type { SessionStep } from '../../karta/src/robotics/session';

export interface RoutineDraftStep {
  id: string;
  kind: SessionStep['kind'];
  seconds: string;
  text: string;
  gesture: 'greeting' | 'attention';
  required: boolean;
}
export interface RoutineDraft { name: string; steps: RoutineDraftStep[] }

export function newDraftStep(kind: SessionStep['kind'], steps: RoutineDraftStep[]): RoutineDraftStep {
  let number = 1;
  const ids = new Set(steps.map(step => step.id));
  while (ids.has(`step-${number}`)) number++;
  return { id: `step-${number}`, kind, seconds: kind === 'speech' ? '5' : '2', text: '', gesture: 'greeting', required: true };
}

export function newRoutineDraft(): RoutineDraft {
  return {
    name: 'Bienvenue',
    steps: [
      { ...newDraftStep('speech', []), text: 'Bienvenue. Prenez un instant pour vous installer confortablement.' },
      { ...newDraftStep('gesture', []), id: 'step-2' },
      { ...newDraftStep('pause', []), id: 'step-3', seconds: '3' },
    ],
  };
}

export function draftFromRoutine(routine: RobotRoutine): RoutineDraft {
  return {
    name: routine.name,
    steps: routine.steps.map(step => ({
      id: step.id, kind: step.kind, seconds: String(step.durationMs / 1000), required: step.required,
      text: step.kind === 'speech' ? step.text : '', gesture: step.kind === 'gesture' ? step.gesture : 'greeting',
    })),
  };
}

export function compileRoutineDraft(draft: RoutineDraft): RobotRoutine {
  const steps = draft.steps.map((step, index) => {
    if (!/^\d+(?:\.\d{1,3})?$/.test(step.seconds)) {
      throw new Error(`Étape ${index + 1} : indiquez une durée avec au maximum trois décimales.`);
    }
    const durationMs = Math.round(Number(step.seconds) * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 60_000) {
      throw new Error(`Étape ${index + 1} : durée hors limites (0,001 à 60 secondes).`);
    }
    const common = { id: step.id, kind: step.kind, durationMs, required: step.required };
    if (step.kind === 'speech') {
      if (!step.text.trim()) throw new Error(`Étape ${index + 1} : ajoutez un texte avant de lancer la séance.`);
      return { ...common, text: step.text };
    }
    if (step.kind === 'gesture') return { ...common, gesture: step.gesture };
    return common;
  });
  return parseRobotRoutine({ format: ROUTINE_FORMAT, version: 1, name: draft.name, steps });
}

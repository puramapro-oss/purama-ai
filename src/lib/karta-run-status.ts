import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Loader2,
  PauseCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';

type KartaRunStatus =
  | 'running'
  | 'executing'
  | 'awaiting_approval'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'simulated'
  | 'partial'
  | 'skipped';

interface KartaRunStatusMeta {
  phase: 'active' | 'approval' | 'complete' | 'unknown';
  label: string;
  title: string;
  description: string;
  icon: LucideIcon;
  className: string;
}

const STATUS_META: Record<KartaRunStatus, KartaRunStatusMeta> = {
  running: {
    phase: 'active', label: 'En cours', title: 'travaille…',
    description: 'La tâche est en cours. Son résultat n’est pas encore confirmé.',
    icon: Loader2, className: 'text-accent-cyan',
  },
  executing: {
    phase: 'active', label: 'Exécution en cours', title: 'exécute la tâche…',
    description: 'L’exécution est en cours. Son résultat n’est pas encore confirmé.',
    icon: Loader2, className: 'text-accent-cyan',
  },
  awaiting_approval: {
    phase: 'approval', label: 'En attente de validation', title: 'attend ta validation',
    description: 'Consulte les actions proposées dans ton équipe avant de les valider.',
    icon: PauseCircle, className: 'text-yellow-500',
  },
  success: {
    phase: 'complete', label: 'Réussi', title: 'a terminé sa tâche',
    description: 'L’exécution est terminée.',
    icon: CheckCircle2, className: 'text-accent-emerald',
  },
  error: {
    phase: 'complete', label: 'Erreur', title: 'a rencontré une erreur',
    description: 'Consulte l’activité pour vérifier le résultat avant de relancer la tâche.',
    icon: XCircle, className: 'text-destructive',
  },
  cancelled: {
    phase: 'complete', label: 'Annulé', title: 'a interrompu la tâche',
    description: 'La tâche a été annulée. Consulte l’activité pour vérifier les actions déjà effectuées.',
    icon: XCircle, className: 'text-muted-foreground',
  },
  simulated: {
    phase: 'complete', label: 'Simulation terminée', title: 'a terminé la simulation',
    description: 'Ce résultat correspond à une simulation.',
    icon: FlaskConical, className: 'text-accent-purple',
  },
  partial: {
    phase: 'complete', label: 'Partiellement terminé', title: 'a terminé une partie de la tâche',
    description: 'La tâche n’est pas entièrement terminée. Consulte l’activité pour vérifier les actions restantes.',
    icon: AlertTriangle, className: 'text-yellow-500',
  },
  skipped: {
    phase: 'complete', label: 'Ignoré', title: 'n’a pas exécuté cette tâche',
    description: 'Cette tâche n’a pas été exécutée. Consulte l’activité pour en connaître la raison.',
    icon: PauseCircle, className: 'text-muted-foreground',
  },
};

const UNKNOWN_STATUS: KartaRunStatusMeta = {
  phase: 'unknown', label: 'Statut à vérifier', title: 'a un résultat à vérifier',
  description: 'Le résultat de cette tâche n’est pas confirmé. Consulte l’activité avant de la relancer.',
  icon: AlertTriangle, className: 'text-yellow-500',
};

/** Shared by the activity timeline and onboarding; unknown states never imply completion. */
export function getKartaRunStatus(run: { status?: unknown; mode?: unknown } | null | undefined): KartaRunStatusMeta {
  const status = run?.status;
  if (typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(STATUS_META, status)) {
    return UNKNOWN_STATUS;
  }
  // Older simulation runs were saved as success. They still represent a simulation.
  if (status === 'success' && run?.mode === 'simulation') return STATUS_META.simulated;
  return STATUS_META[status as KartaRunStatus];
}

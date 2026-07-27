import { PauseCircle, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useResolvePendingAction } from '@/hooks/useKartaEmployees';
import { formatRelative } from '@/lib/utils';

interface PendingActionItem {
  id: string;
  tool_name: string;
  created_at: string;
  agentName?: string;
}

interface PendingActionsListProps {
  actions: PendingActionItem[];
  /** true = bouton icône seule dans un panneau compact (Créateur d'Agents) ; false = carte pleine largeur (Mes employés IA). */
  compact?: boolean;
}

/**
 * Liste d'actions en attente de validation humaine avec Approuver/Rejeter — partagée entre
 * "Mes employés IA" (12 agents fixes) et "Créateur d'Agents" (agents dynamiques), même mécanisme
 * karta_pending_actions cf ERRORS.md 2026-07-27.
 */
export function PendingActionsList({ actions, compact = false }: PendingActionsListProps) {
  const resolve = useResolvePendingAction();

  if (actions.length === 0) return null;

  const handle = (pendingActionId: string, decision: 'approve' | 'reject') => {
    resolve.mutate(
      { pendingActionId, decision },
      {
        onSuccess: () => toast.success(decision === 'approve' ? 'Action exécutée' : 'Action rejetée'),
        onError: (e) =>
          toast.error('Erreur', { description: e instanceof Error ? e.message : "Impossible de traiter cette action" }),
      },
    );
  };

  if (compact) {
    return (
      <div className="space-y-1.5 p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/30">
        <Label className="text-xs flex items-center gap-1.5">
          <PauseCircle className="w-3.5 h-3.5 text-yellow-500" /> En attente de ta validation
        </Label>
        {actions.map((action) => (
          <div key={action.id} className="flex items-center justify-between gap-2 py-1.5">
            <p className="text-xs text-foreground/80 truncate">
              Exécuter <span className="font-mono text-[11px] bg-secondary/60 px-1 rounded">{action.tool_name}</span>
            </p>
            <div className="flex gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                onClick={() => handle(action.id, 'reject')}
                className="h-7 px-2 border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" disabled={resolve.isPending} onClick={() => handle(action.id, 'approve')} className="h-7 px-2">
                <Check className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {actions.map((action) => (
        <div key={action.id} className="flex items-start gap-3 py-3 border-b border-yellow-500/20 last:border-0">
          <PauseCircle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {action.agentName} veut exécuter{' '}
              <span className="font-mono text-xs bg-secondary/60 px-1.5 py-0.5 rounded">{action.tool_name}</span>
            </p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">Demandé {formatRelative(action.created_at)}</p>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => handle(action.id, 'reject')}
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
            >
              <X className="w-3.5 h-3.5 mr-1" /> Rejeter
            </Button>
            <Button size="sm" disabled={resolve.isPending} onClick={() => handle(action.id, 'approve')}>
              <Check className="w-3.5 h-3.5 mr-1" /> Approuver
            </Button>
          </div>
        </div>
      ))}
    </>
  );
}

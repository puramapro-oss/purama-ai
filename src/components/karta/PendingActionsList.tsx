import { PauseCircle, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { useResolvePendingAction } from '@/hooks/useKartaEmployees';
import { formatRelative } from '@/lib/utils';

interface PendingActionItem {
  id: string;
  tool_name: string;
  tool_params: unknown;
  created_at: string;
  status: string;
  result_summary?: string | null;
  agentName?: string;
}

interface PendingActionsListProps {
  actions: PendingActionItem[];
  /** true = bouton icône seule dans un panneau compact (Créateur d'Agents) ; false = carte pleine largeur (Mes employés IA). */
  compact?: boolean;
}

/**
 * Actions à valider ou à vérifier. Approuver/Rejeter sont réservés à pending — partagée entre
 * "Mes employés IA" (12 agents fixes) et "Créateur d'Agents" (agents dynamiques), même mécanisme
 * karta_pending_actions cf ERRORS.md 2026-07-27.
 */
export function PendingActionsList({ actions, compact = false }: PendingActionsListProps) {
  const resolve = useResolvePendingAction();

  if (actions.length === 0) return null;

  const actionsWithParameters = actions.map((action) => ({
    ...action,
    parameterText: formatActionParameters(action.tool_params),
  }));

  const handle = (pendingActionId: string, decision: 'approve' | 'reject') => {
    resolve.mutate(
      { pendingActionId, decision },
      {
        onSuccess: (result) => toast.success(decision === 'approve' ? 'Exécution confirmée' : 'Action rejetée', { description: result.resultSummary }),
        onError: (e) =>
          toast.error('Erreur', { description: e instanceof Error ? e.message : "Impossible de traiter cette action" }),
      },
    );
  };

  if (compact) {
    return (
      <div className="space-y-1.5 p-3 rounded-lg bg-yellow-500/5 border border-yellow-500/30">
        <Label className="text-xs flex items-center gap-1.5">
          <PauseCircle className="w-3.5 h-3.5 text-yellow-500" /> Actions à valider ou à vérifier
        </Label>
        {actionsWithParameters.map((action) => (
          <div key={action.id} className="flex items-center justify-between gap-2 py-1.5">
            <div className="min-w-0">
              <p className="text-xs text-foreground/80 truncate">
                {action.status === 'pending' ? 'Exécuter' : 'Vérifier'} <span className="font-mono text-[11px] bg-secondary/60 px-1 rounded">{action.tool_name}</span>
              </p>
              {action.status !== 'pending' && <p className="text-xs text-yellow-500 mt-1">{actionStatusMessage(action.status)}</p>}
              {action.result_summary && <p className="text-xs text-muted-foreground mt-1">{action.result_summary}</p>}
              <details className="mt-2 text-xs" open={action.status === 'pending'}>
                <summary className="cursor-pointer text-foreground">Paramètres complets de l'action</summary>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/60 p-2 text-[11px]">{action.parameterText ?? 'Paramètres indisponibles — approbation désactivée.'}</pre>
              </details>
            </div>
            {action.status === 'pending' && <div className="flex gap-1.5 flex-shrink-0">
              <Button
                size="sm"
                variant="outline"
                disabled={resolve.isPending}
                aria-label="Rejeter l'action"
                onClick={() => handle(action.id, 'reject')}
                className="h-7 px-2 border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                <X className="w-3.5 h-3.5" />
              </Button>
              <Button size="sm" disabled={resolve.isPending || action.parameterText === null} aria-label="Approuver l'action" onClick={() => handle(action.id, 'approve')} className="h-7 px-2">
                <Check className="w-3.5 h-3.5" />
              </Button>
            </div>}
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      {actionsWithParameters.map((action) => (
        <div key={action.id} className="flex items-start gap-3 py-3 border-b border-yellow-500/20 last:border-0">
          <PauseCircle className="w-5 h-5 text-yellow-500 mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">
              {action.agentName} {action.status === 'pending' ? 'veut exécuter' : '— action à vérifier :'}{' '}
              <span className="font-mono text-xs bg-secondary/60 px-1.5 py-0.5 rounded">{action.tool_name}</span>
            </p>
            {action.status !== 'pending' && <p className="text-xs text-yellow-500 mt-1">{actionStatusMessage(action.status)}</p>}
            {action.result_summary && <p className="text-xs text-muted-foreground mt-1">{action.result_summary}</p>}
            <details className="mt-2 text-xs" open={action.status === 'pending'}>
              <summary className="cursor-pointer text-foreground">Paramètres complets de l'action</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-secondary/60 p-2 text-[11px]">{action.parameterText ?? 'Paramètres indisponibles — approbation désactivée.'}</pre>
            </details>
            <p className="text-[10px] text-muted-foreground/60 mt-1">Demandé {formatRelative(action.created_at)}</p>
          </div>
          {action.status === 'pending' && <div className="flex gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              disabled={resolve.isPending}
              onClick={() => handle(action.id, 'reject')}
              className="border-destructive/30 text-destructive hover:bg-destructive/10"
            >
              <X className="w-3.5 h-3.5 mr-1" /> Rejeter
            </Button>
            <Button size="sm" disabled={resolve.isPending || action.parameterText === null} onClick={() => handle(action.id, 'approve')}>
              <Check className="w-3.5 h-3.5 mr-1" /> Approuver
            </Button>
          </div>}
        </div>
      ))}
    </>
  );
}

function formatActionParameters(params: unknown): string | null {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return null;
  try {
    return JSON.stringify(params, null, 2) ?? null;
  } catch {
    return null;
  }
}

function actionStatusMessage(status: string): string {
  if (status === 'executing') return "Prise en charge enregistrée. Si cet état persiste, vérifier le service concerné sans relancer l'action.";
  if (status === 'blocked') return 'Action bloquée avant exécution. Vérifier les réglages et le journal.';
  return "Résultat inconnu : vérifier le service concerné. Ne pas relancer l'action.";
}

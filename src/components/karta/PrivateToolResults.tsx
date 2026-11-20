import { useLayoutEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { createRequestScope } from '@/lib/request-scope';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import {
  deletePrivateToolResult, listPrivateToolResults,
  type PrivateToolResult, type PrivateToolResultStatus,
} from '@/lib/private-tool-results';

interface Props {
  ownerId: string;
  agentId: string;
  sessionId: string;
  selectedIds: readonly string[];
  onToggle: (resultId: string) => void;
  onRemove: (resultId: string) => void;
  onUseResults: () => void;
  disabled?: boolean;
}

const STATUS_LABEL: Record<PrivateToolResultStatus, string> = {
  complete: 'Complet', empty: 'Aucun résultat', partial: 'Partiel', failed: 'Indisponible',
};
const RESULT_TITLE = {
  knowledge_search: 'Recherche de références', quantum_simulate: 'Simulation quantique locale',
};

/** Private mission deliverables stay separate from activity traces and model calls. */
export function PrivateToolResults({
  ownerId, agentId, sessionId, selectedIds, onToggle, onRemove, onUseResults, disabled = false,
}: Props) {
  const scopeKey = JSON.stringify([ownerId, agentId, sessionId]);
  const captureScope = useRequestScope(scopeKey);
  const [requests] = useState(createRequestScope);
  const [results, setResults] = useScopedState<PrivateToolResult[]>(scopeKey, []);
  const [loading, setLoading] = useScopedState(scopeKey, true);
  const [loadError, setLoadError] = useScopedState<string | null>(scopeKey, null);
  const [deleteError, setDeleteError] = useScopedState<string | null>(scopeKey, null);
  const [refreshVersion, setRefreshVersion] = useScopedState(scopeKey, 0);
  const [confirmId, setConfirmId] = useScopedState<string | null>(scopeKey, null);
  const [deletingId, setDeletingId] = useScopedState<string | null>(scopeKey, null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    requests.invalidate();
    setResults([]);
    setLoading(true);
    setLoadError(null);
    setDeleteError(null);
    setConfirmId(null);
    setDeletingId(null);
    const request = requests.begin('list');
    if (!request) return;
    const isCurrent = captureScope();
    void listPrivateToolResults(ownerId, agentId, request.signal)
      .then(next => {
        if (request.current() && isCurrent()) setResults(next);
      })
      .catch(() => {
        if (request.current() && isCurrent()) {
          setResults([]);
          setLoadError('Impossible de charger les résultats privés. Tu peux réessayer.');
        }
      })
      .finally(() => {
        if (request.finish() && isCurrent()) setLoading(false);
      });
    return () => requests.invalidate();
  }, [ownerId, agentId, sessionId, refreshVersion, captureScope, requests,
    setResults, setLoading, setLoadError, setDeleteError, setConfirmId, setDeletingId]);

  const removeResult = async (result: PrivateToolResult) => {
    const isCurrent = captureScope();
    if (disabled || !isCurrent() || confirmId !== result.id || deletingId !== null) return;
    const request = requests.begin('delete');
    if (!request) return;
    setDeletingId(result.id);
    setDeleteError(null);
    try {
      await deletePrivateToolResult(ownerId, agentId, result.id, request.signal);
      if (!request.current() || !isCurrent()) return;
      setResults(previous => previous.filter(row => row.id !== result.id));
      onRemove(result.id);
      setConfirmId(null);
      resultsHeadingRef.current?.focus();
    } catch {
      if (request.current() && isCurrent()) {
        setDeleteError('Suppression non confirmée. Actualise les résultats ; si la mission est encore en cours, attends sa fin.');
      }
    } finally {
      if (request.finish() && isCurrent()) setDeletingId(null);
    }
  };

  return <section aria-labelledby="private-tool-results-title" className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 ref={resultsHeadingRef} tabIndex={-1} id="private-tool-results-title" className="font-semibold text-foreground">Résultats privés de cet agent</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Consulte les 20 résultats les plus récents de ses recherches et simulations, puis choisis jusqu’à trois résultats à joindre à ta prochaine question.
        </p>
      </div>
      <Button type="button" variant="outline" size="sm"
        disabled={loading || deletingId !== null || disabled}
        onClick={() => setRefreshVersion(value => value + 1)}>
        {loading ? <Loader2 aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
          : <RefreshCw aria-hidden="true" className="mr-2 h-4 w-4" />}
        Actualiser les résultats
      </Button>
    </div>

    <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {loading ? 'Chargement des résultats privés…'
        : selectedIds.length > 0 ? `${selectedIds.length} résultat${selectedIds.length > 1 ? 's' : ''} sélectionné${selectedIds.length > 1 ? 's' : ''} sur 3.`
          : 'Aucun résultat joint à la prochaine question.'}
    </div>
    {loadError ? <p role="alert" className="text-sm text-destructive">{loadError}</p> : null}
    {deleteError ? <p role="alert" className="text-sm text-destructive">{deleteError}</p> : null}
    {!loading && !loadError && results.length === 0 ? <p className="text-sm text-muted-foreground">
      Aucun résultat privé disponible. Les recherches et simulations réellement exécutées apparaîtront ici.
    </p> : null}

    <div className="space-y-3">
      {results.map(result => {
        const selected = selectedIds.includes(result.id);
        const title = RESULT_TITLE[result.tool_name];
        const selectionDisabled = disabled || deletingId !== null || (!selected && selectedIds.length >= 3);
        return <article key={result.id} className="rounded-lg border border-border bg-secondary/20 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-foreground">{title}</h3>
            <Badge variant="outline">{STATUS_LABEL[result.payload.status]}</Badge>
            <time dateTime={result.created_at} className="text-xs text-muted-foreground">
              {new Date(result.created_at).toLocaleString('fr-FR')}
            </time>
          </div>
          <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground/90">{result.payload.summary}</p>
          {result.payload.sources.length > 0 ? <div className="mt-3">
            <h4 className="text-sm font-medium">Références reçues</h4>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {result.payload.sources.map((source, index) => <li key={`${source.source}:${source.native_id}:${index}`}>
                <a href={source.url} target="_blank" rel="noopener noreferrer"
                  className="break-words text-accent-cyan underline underline-offset-2">
                  {source.label} <span className="sr-only">(nouvel onglet)</span>
                </a>
                <span className="text-xs text-muted-foreground"> — {source.source === 'crossref' ? 'Crossref' : 'Wikidata'}</span>
              </li>)}
            </ul>
          </div> : null}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className={`flex items-center gap-2 text-sm ${selectionDisabled ? 'text-muted-foreground' : 'cursor-pointer'}`}>
              <input type="checkbox" checked={selected} disabled={selectionDisabled}
                onChange={() => onToggle(result.id)}
                aria-label={`Joindre ${title.toLowerCase()} du ${new Date(result.created_at).toLocaleString('fr-FR')} à ma prochaine question`} />
              Joindre à ma prochaine question
            </label>
            <Button type="button" variant="outline" size="sm" data-remove-result
              disabled={disabled || deletingId !== null}
              onClick={() => { setDeleteError(null); setConfirmId(result.id); }}
              aria-label={`Supprimer le résultat : ${title}`}>
              Supprimer
            </Button>
          </div>
          {confirmId === result.id ? <div role="group" aria-label="Confirmer la suppression" className="mt-3 space-y-2 rounded-md border border-border p-3">
            <p role="alert" className="text-sm">Supprimer ce résultat privé de mission ? Cette suppression est définitive.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" size="sm" disabled={disabled || deletingId !== null}
                onClick={() => void removeResult(result)}>
                {deletingId === result.id ? 'Suppression…' : 'Confirmer la suppression'}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={deletingId !== null}
                onClick={event => {
                  setConfirmId(null);
                  event.currentTarget.closest('article')?.querySelector<HTMLButtonElement>('[data-remove-result]')?.focus();
                }}>Annuler</Button>
            </div>
          </div> : null}
        </article>;
      })}
    </div>
    {selectedIds.length > 0 ? <Button type="button" disabled={disabled || deletingId !== null} onClick={onUseResults}>
      Poser une question avec ces résultats
    </Button> : null}
  </section>;
}

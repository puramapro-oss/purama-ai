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
import type { ResolutionPrivateResultView, ResolutionSuppliedReference } from '../../../karta/src/knowledge/private-result-view';

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
  programmatic_report: 'Synthèse de recherche',
  qualify_resolution: 'Analyse de dossier',
};

const REFERENCE_KIND_LABEL: Record<ResolutionSuppliedReference['kind'], string> = {
  requirement: 'Exigence déclarée', satisfaction: 'Condition déclarée satisfaite',
  alternative: 'Alternative déclarée', acceptance: 'Acceptation déclarée',
  activation: 'Activation déclarée', correction: 'Correction déclarée',
  transmission: 'Transmission déclarée', responsibility: 'Prise en charge déclarée',
  performance: 'Réalisation déclarée', authorization: 'Autorisation déclarée',
};

/** This is the supplied snapshot, not an assertion about a current external dossier. */
function ResolutionDetails({ resolution, resultId, summary }: { resolution: ResolutionPrivateResultView; resultId: string; summary: string }) {
  const rejected = new Set(resolution.rejected_source_ids);
  return <div className="mt-3 space-y-4">
    <p className="text-sm text-muted-foreground">
      Cette analyse reprend les informations fournies. Les références et les droits restent à vérifier ; aucune démarche extérieure n’a été effectuée par cette analyse.
    </p>
    <dl className="grid gap-2 rounded-md border border-border p-3 text-sm sm:grid-cols-3">
      <div className="min-w-0"><dt className="text-muted-foreground">Dossier fourni</dt><dd className="break-words">{resolution.snapshot.caseId}</dd></div>
      <div><dt className="text-muted-foreground">Révision fournie</dt><dd>{resolution.snapshot.snapshotRevision}</dd></div>
      <div className="min-w-0"><dt className="text-muted-foreground">Date de l’instantané fournie</dt><dd className="break-words">
        <time dateTime={resolution.snapshot.asOf} title={resolution.snapshot.asOf}>
          {new Date(resolution.snapshot.asOf).toLocaleString('fr-FR', { timeZoneName: 'short' })}
        </time>
      </dd></div>
    </dl>
    <details className="rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        Contexte et orientations du dossier
      </summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{summary}</p>
    </details>
    <div className="space-y-3">
      {resolution.sections.map(section => <section key={section.id} aria-labelledby={`${resultId}-${section.id}`} className="min-w-0 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 id={`${resultId}-${section.id}`} className="font-medium text-foreground">{section.title}</h4>
          {section.availability === 'not_provided' ? <Badge variant="outline">Informations non fournies</Badge> : null}
        </div>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm">{section.summary}</p>
        {section.items.length > 0 ? <details className="mt-2 text-sm">
          <summary className="cursor-pointer rounded-sm text-accent-cyan focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            Voir les détails de cette rubrique ({section.items.length})
          </summary>
          <ul className="mt-2 list-disc space-y-2 pl-5">
            {section.items.map((item, index) => <li key={index} className="whitespace-pre-wrap break-words">{item}</li>)}
          </ul>
        </details> : null}
      </section>)}
    </div>
    <details className="min-w-0 rounded-md border border-border p-3 text-sm">
      <summary className="cursor-pointer rounded-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
        Références fournies ({resolution.supplied_references.length})
      </summary>
      <p className="mt-2 text-muted-foreground">Ces références sont déclarées et non authentifiées. Leur affichage ne consulte aucun site ni document extérieur.</p>
      {resolution.supplied_references.length === 0 ? <p className="mt-2">Aucune référence fournie.</p> : <ul className="mt-3 space-y-3">
        {resolution.supplied_references.map(reference => <li key={reference.id} className="min-w-0 rounded-md bg-secondary/30 p-3">
          <div className="flex flex-wrap items-start gap-2">
            <span className="min-w-0 break-words font-medium">{reference.id}</span>
            {rejected.has(reference.id) ? <Badge variant="outline">Non retenue par l’analyse</Badge> : null}
          </div>
          <p className="mt-1 text-muted-foreground">{REFERENCE_KIND_LABEL[reference.kind]}</p>
          <p className="mt-2 whitespace-pre-wrap break-words">{reference.reference}</p>
          <dl className="mt-2 space-y-1 text-xs text-muted-foreground">
            <div><dt className="inline">Dossier déclaré : </dt><dd className="inline break-words">{reference.caseId}</dd></div>
            <div><dt className="inline">Révision déclarée : </dt><dd className="inline">{reference.snapshotRevision}</dd></div>
            <div><dt className="inline">Élément concerné déclaré : </dt><dd className="inline break-words">{reference.subjectId}</dd></div>
            <div><dt className="inline">Date d’observation fournie : </dt><dd className="inline break-words">{reference.observedAt}</dd></div>
          </dl>
        </li>)}
      </ul>}
    </details>
  </div>;
}

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
          Consulte les 20 résultats les plus récents de ses recherches, synthèses, analyses de dossier et simulations, puis choisis jusqu’à trois résultats à joindre à ta prochaine question.
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
      Aucun résultat privé disponible. Les recherches, synthèses, analyses de dossier et simulations réellement produites apparaîtront ici.
    </p> : null}

    <div className="space-y-3">
      {results.map(result => {
        const selected = selectedIds.includes(result.id);
        const title = RESULT_TITLE[result.tool_name];
        const selectionDisabled = disabled || deletingId !== null || (!selected && selectedIds.length >= 3);
        return <article key={result.id} className="rounded-lg border border-border bg-secondary/20 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-medium text-foreground">{title}</h3>
            <Badge variant="outline">{result.tool_name === 'qualify_resolution' ? 'Analyse disponible' : STATUS_LABEL[result.payload.status]}</Badge>
            <time dateTime={result.created_at} className="text-xs text-muted-foreground">
              {result.tool_name === 'qualify_resolution' ? 'Enregistrée le ' : null}
              {new Date(result.created_at).toLocaleString('fr-FR')}
            </time>
          </div>
          {result.tool_name === 'programmatic_report' ? <p className="mt-2 text-xs text-muted-foreground">
            Synthèse générée par le modèle ; ses affirmations restent à vérifier.
          </p> : null}
          {result.payload.resolution
            ? <ResolutionDetails resolution={result.payload.resolution} resultId={result.id} summary={result.payload.summary} />
            : <p className="mt-3 whitespace-pre-wrap break-words text-sm text-foreground/90">{result.payload.summary}</p>}
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

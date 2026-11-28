import { useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import { AFFILIATION_REQUIREMENTS, listMediaAffiliationCandidates, preparePartnerAffiliationAdmission,
  partnerAffiliationBlockedMessage, type MediaAffiliationCandidate, type PartnerAffiliationPreparation } from '@/lib/partner-completion';

type Prepared = Extract<PartnerAffiliationPreparation, { status: 'prepared' }>;
type RowState = { busy?: boolean; error?: string; prepared?: Prepared };

export function PartnerAffiliationAdmissions({ ownerId }: { ownerId: string }) {
  const capture = useRequestScope(ownerId);
  const [page, setPage] = useScopedState(ownerId, 0);
  const [rows, setRows] = useScopedState<MediaAffiliationCandidate[]>(ownerId, []);
  const [hasMore, setHasMore] = useScopedState(ownerId, false);
  const [loading, setLoading] = useScopedState(ownerId, true);
  const [error, setError] = useScopedState(ownerId, '');
  const [states, setStates] = useScopedState<Record<string, RowState>>(ownerId, {});
  const requests = useRef(new Set<string>());
  const listSequence = useRef(0);
  useEffect(() => { setStates({}); requests.current.clear(); }, [ownerId, setStates]);
  const refresh = useCallback(async () => {
    const current = capture();
    const sequence = ++listSequence.current;
    setLoading(true); setError(''); setRows([]);
    try {
      const value = await listMediaAffiliationCandidates(ownerId, page);
      if (current() && sequence === listSequence.current) { setRows(value.candidates); setHasMore(value.hasMore); }
    } catch (reason) {
      if (current() && sequence === listSequence.current) setError(reason instanceof Error ? reason.message : 'Les accords médias ne sont pas disponibles.');
    } finally { if (current() && sequence === listSequence.current) setLoading(false); }
  }, [capture, ownerId, page, setError, setHasMore, setLoading, setRows]);
  useEffect(() => { void refresh(); }, [refresh]);

  const prepare = async (prospect: MediaAffiliationCandidate) => {
    const key = `${ownerId}:${prospect.id}`;
    if (requests.current.has(key) || prospect.user_id !== ownerId) return;
    const current = capture();
    requests.current.add(key);
    setStates(previous => ({ ...previous, [prospect.id]: { busy: true } }));
    try {
      const result = await preparePartnerAffiliationAdmission(ownerId, prospect.id);
      if (current()) setStates(previous => ({ ...previous, [prospect.id]: result.status === 'prepared'
        ? { prepared: result } : { error: partnerAffiliationBlockedMessage(result.reason) } }));
    } catch (reason) {
      if (current()) setStates(previous => ({ ...previous, [prospect.id]: {
        error: reason instanceof Error ? reason.message : 'La préparation n’a pas pu être confirmée.',
      } }));
    } finally { if (current()) requests.current.delete(key); }
  };

  const download = (prepared: Prepared) => {
    if (prepared.admission.user_id !== ownerId) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(prepared, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `PURAMA_ADMISSION_MEDIA_${prepared.admission.id}.json`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    // Let the browser consume the object URL before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <Card className="border-border bg-card"><CardContent className="space-y-4 p-5">
    <div>
      <h2 className="font-semibold text-foreground">Accords médias à raccorder à l’affiliation</h2>
      <p className="mt-1 text-sm text-muted-foreground">Préparez un dossier à partir du contrat approuvé et de sa signature vérifiée.
        Il conserve les conditions de l’accord et les éléments nécessaires à son raccordement à ONE.</p>
    </div>
    {loading ? <p role="status" className="text-sm">Chargement des accords…</p> : error ? <div role="alert" className="space-y-2 text-sm">
      <p>{error}</p><Button variant="outline" size="sm" onClick={() => void refresh()}>Réessayer les accords</Button>
    </div> : rows.length === 0 ? <p className="text-sm text-muted-foreground">Aucun accord média signé à présenter sur cette page.
      {' '}<Link className="underline" to="/dashboard/partner-agent/prospects">Consulter les prospects et les signatures</Link>.</p>
    : <div className="space-y-3">{rows.filter(row => row.user_id === ownerId).map(row => {
      const state = states[row.id];
      return <div key={row.id} className="space-y-2 rounded-lg border border-border p-3">
        <p className="font-medium">{row.name}</p>
        <Button size="sm" variant="outline" disabled={state?.busy} onClick={() => void prepare(row)}>
          {state?.busy ? 'Vérification du contrat…' : state?.prepared ? 'Revérifier le dossier' : 'Préparer le dossier d’affiliation'}
        </Button>
        {state?.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
        {state?.prepared && <div role="status" className="space-y-2 text-sm">
          <p>{state.prepared.reused ? 'Dossier enregistré retrouvé.' : 'Dossier enregistré.'} L’affiliation et les versements restent à raccorder.</p>
          <p className="text-muted-foreground">Éléments restant à qualifier :</p>
          <ul className="list-disc space-y-1 pl-5">{state.prepared.integration.missing.map(code =>
            <li key={code}>{AFFILIATION_REQUIREMENTS[code] ?? 'Élément complémentaire à qualifier dans le dossier'}</li>)}</ul>
          <Button size="sm" variant="outline" onClick={() => download(state.prepared!)}>Exporter le dossier vérifié</Button>
        </div>}
      </div>;
    })}</div>}
    {!loading && !error && (page > 0 || hasMore) && <div className="flex items-center gap-3 text-sm">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Page précédente</Button>
      <span>Page {page + 1}</span>
      <Button variant="outline" size="sm" disabled={!hasMore} onClick={() => setPage(value => value + 1)}>Page suivante</Button>
    </div>}
  </CardContent></Card>;
}

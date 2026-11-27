import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createRequestScope } from '@/lib/request-scope';
import {
  ConsultationClientError, CONSULTATION_MAX_REQUEST_BYTES, consultationSourceUrl, createConsultationClient,
  type ConsultationCatalog, type ConsultationOperation,
} from '@/lib/consultation-client';
import type { ConsultationReflection, ConsultationSpeed } from '../../karta/src/api/consultation-contract';

const reflectionLabels = { auto: 'Automatique (standard)', standard: 'Standard', deep: 'Approfondie', maximum: 'Maximale' };
const speedLabels = { standard: 'Standard', fast: 'Rapide', ultra_fast: 'Ultra rapide' };
const providerLabels: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google', xai: 'xAI' };
const availabilityLabels: Record<ConsultationCatalog['reason'], string> = {
  ready: 'Consultation disponible.',
  not_configured: 'La consultation n’est pas encore configurée.',
  simulation_enabled: 'Le moteur est en mode simulation. La consultation réelle n’est pas disponible.',
  account_unavailable: 'La capacité d’analyse n’est pas disponible pour cette consultation.',
  budget_unavailable: 'Aucune capacité financée n’est disponible pour ce compte.',
  model_unavailable: 'Aucune capacité d’analyse compatible n’est disponible.',
  paused: 'La consultation est suspendue par l’exploitation.',
  service_unavailable: 'Le service est temporairement indisponible.',
};
const operationLabels: Record<ConsultationOperation['status'], string> = {
  running: 'Consultation en cours.', complete: 'Réponse reçue.', partial: 'Réponse partielle reçue.',
  failed: 'La consultation n’a pas abouti.', blocked: 'La consultation n’a pas pu démarrer.', cancelled: 'Consultation annulée.',
  reconciliation_required: 'Le suivi des usages doit être rapproché. Aucun nouvel appel n’est lancé par la reprise.',
};
const storageKey = (userId: string) => `purama.consultation.pending.${userId}`;
function retainedId(userId: string): string | null {
  try {
    const value = sessionStorage.getItem(storageKey(userId));
    return value && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
  } catch { return null; }
}
function retain(userId: string, operationId: string | null) {
  try {
    if (operationId) sessionStorage.setItem(storageKey(userId), operationId);
    else sessionStorage.removeItem(storageKey(userId));
  } catch { /* The operation remains recoverable while this panel is open. */ }
}
const lines = (value: string) => value.split('\n').map(row => row.trim()).filter(Boolean);
const publicError = (error: unknown) => error instanceof ConsultationClientError
  ? error.message : 'L’état de la consultation n’a pas pu être confirmé.';
const fieldClass = 'mt-1 w-full rounded-md border border-input bg-background px-2 py-2 text-sm disabled:opacity-50';
const buttonClass = 'rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary';

function choosePublicCouncil(models: ConsultationCatalog['models']) {
  for (const reflection of ['deep', 'maximum'] as const) {
    const candidates = models.flatMap(model => {
      const profile = model.profiles.find(item => item.reflection === reflection && item.speed === 'standard');
      return profile ? [{ model: model.model, limits: profile.research }] : [];
    });
    const lead = candidates.find(item => item.limits.maxRounds >= 2 && item.limits.maxReviewers >= 1);
    if (!lead || candidates.length < 2) continue;
    const reviewerModels = candidates.filter(item => item.model !== lead.model)
      .slice(0, Math.min(2, lead.limits.maxReviewers)).map(item => item.model);
    return { preferences: { model: lead.model, reflection, speed: 'standard' as const }, reviewerModels };
  }
  return null;
}

function ConsultationSources({ sources, technicalDetails }: {
  sources: NonNullable<ConsultationOperation['result']>['sources']; technicalDetails: boolean;
}) {
  return <ol className="mt-2 space-y-2 text-xs">{sources.map(source => <li key={source.id} className="break-words">
    <a href={consultationSourceUrl(source.url) ?? undefined} target="_blank" rel="noopener noreferrer" className="underline text-primary">
      {source.id} — {source.title || source.url}
    </a>
    <p className="text-muted-foreground">{technicalDetails && <>{source.provider} · </>}{source.retrievedAt}</p>
    {source.text.trim() ? <p className="whitespace-pre-wrap">{source.text}</p>
      : <p className="text-muted-foreground">Aucun extrait de texte disponible.</p>}
    {source.truncated && <p className="text-muted-foreground">Titre ou extrait abrégé.</p>}
  </li>)}</ol>;
}

/** One private operation at a time. Recovery reads status; it never sends the
 * question again. Only the opaque operation UUID is retained across reloads. */
export function ConsultationPanel({ userId, accessToken, technicalDetails = false }: {
  userId: string; accessToken: string;
  /** Presentation only. Account, model and budget authorization remains server-side. */
  technicalDetails?: boolean;
}) {
  const [scope] = useState(createRequestScope);
  const client = useMemo(() => {
    try { return createConsultationClient(accessToken); } catch { return null; }
  }, [accessToken]);
  const [catalog, setCatalog] = useState<ConsultationCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [reflection, setReflection] = useState<ConsultationReflection>('auto');
  const [speed, setSpeed] = useState<ConsultationSpeed>('standard');
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [council, setCouncil] = useState<ReturnType<typeof choosePublicCouncil>>(null);
  const [question, setQuestion] = useState('');
  const [queries, setQueries] = useState('');
  const [urls, setUrls] = useState('');
  const [operationId, setOperationId] = useState<string | null>(() => retainedId(userId));
  const [operation, setOperation] = useState<ConsultationOperation | null>(null);
  const [busy, setBusy] = useState<'consult' | 'status' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    scope.invalidate();
    setCatalog(null); setCatalogError(null); setModel(''); setReflection('auto'); setSpeed('standard'); setReviewers([]);
    setCouncil(null); setQuestion(''); setQueries(''); setUrls(''); setOperation(null); setOperationId(retainedId(userId)); setBusy(null); setError(null);
    return () => scope.invalidate();
  }, [scope, userId, technicalDetails]);

  useEffect(() => {
    scope.cancel('catalog');
    const lease = scope.begin('catalog');
    if (!lease) return;
    if (!client) { setCatalogError('Connectez-vous pour utiliser la consultation.'); lease.finish(); return; }
    void client.catalog(lease.signal).then(value => {
      if (!lease.current()) return;
      setCatalog(value); setCatalogError(null);
      setModel(current => current || value.models[0]?.model || '');
    }).catch(cause => { if (lease.current()) setCatalogError(publicError(cause)); })
      .finally(() => lease.finish());
    return () => scope.cancel('catalog');
  }, [client, scope, userId, technicalDetails]);

  // Keep the exact panel accepted for this question even if the catalogue changes.
  const councilOffer = !technicalDetails && catalog?.available ? choosePublicCouncil(catalog.models) : null;
  const activeCouncil = technicalDetails ? null : council;
  const defaultModel = catalog?.models.find(item => item.profiles.some(variant => variant.reflection === 'auto' && variant.speed === 'standard'));
  const preferences = technicalDetails ? { model, reflection, speed }
    : activeCouncil?.preferences ?? { model: defaultModel?.model ?? '', reflection: 'auto' as const, speed: 'standard' as const };
  const selected = catalog?.models.find(item => item.model === preferences.model);
  const activeReviewers = technicalDetails ? reviewers : activeCouncil?.reviewerModels ?? [];
  const profile = selected?.profiles.find(item => item.reflection === preferences.reflection && item.speed === preferences.speed);
  const searchQueries = lines(queries);
  const pageUrls = lines(urls);
  const requestFields = { question: question.trim(), preferences,
    reviewerModels: [...activeReviewers], research: { queries: searchQueries, urls: pageUrls } };
  const problems: string[] = [];
  if (catalog?.available) {
    if (!activeCouncil && (!selected || !profile)) problems.push(technicalDetails ? 'Choisissez un modèle et des réglages disponibles.'
      : 'L’analyse automatique est temporairement indisponible. Réessayez plus tard.');
    if (question.length > 8000) problems.push('La question est limitée à 8 000 caractères.');
    const tooManyReviewers = profile && activeReviewers.length > profile.research.maxReviewers;
    const incompatibleReviewer = activeReviewers.some(name => name === preferences.model || !catalog.models.some(item => item.model === name
      && item.profiles.some(variant => variant.reflection === preferences.reflection && variant.speed === preferences.speed)));
    if (activeCouncil && (!profile || profile.research.maxRounds < 2 || tooManyReviewers || incompatibleReviewer)) {
      problems.push('Ce Conseil est devenu indisponible. Désactivez-le pour choisir une autre analyse.');
    }
    if (technicalDetails && tooManyReviewers) problems.push(`Ce profil autorise ${profile.research.maxReviewers} avis supplémentaires. Retirez les avis en trop.`);
    if (technicalDetails && incompatibleReviewer) {
      problems.push('Retirez les modèles consultés qui ne prennent pas en charge ces réglages ou qui sont déjà le modèle principal.');
    }
    if (searchQueries.length && !catalog.research.search) problems.push('La recherche web n’est pas disponible. Retirez les requêtes pour continuer sans recherche.');
    if (pageUrls.length && !catalog.research.scrape) problems.push('La lecture de pages n’est pas disponible. Retirez les adresses pour continuer sans lecture.');
    if (profile && searchQueries.length > profile.research.maxSearches) problems.push(`Ce profil autorise ${profile.research.maxSearches} requêtes publiques. Retirez les requêtes en trop.`);
    if (profile && pageUrls.length > profile.research.maxPages) problems.push(`Ce profil autorise ${profile.research.maxPages} pages. Retirez les adresses en trop.`);
    if (searchQueries.some(query => query.length > 2000)) problems.push('Chaque requête publique est limitée à 2 000 caractères.');
    if (pageUrls.some(url => !consultationSourceUrl(url))) problems.push('Les pages doivent avoir une adresse HTTPS sans identifiants.');
    if (new TextEncoder().encode(JSON.stringify({ action: 'consult', operationId: '00000000-0000-0000-0000-000000000000', ...requestFields })).byteLength > CONSULTATION_MAX_REQUEST_BYTES) {
      problems.push('L’ensemble de la question et des recherches est trop volumineux. Réduisez les textes ou les adresses.');
    }
  }
  const locked = operationId !== null || busy !== null;
  const remember = (id: string | null) => { setOperationId(id); retain(userId, id); };
  const apply = (value: ConsultationOperation | null) => {
    if (!value) { setError('Aucun résultat reçu pour cette demande. Son état reste à confirmer.'); return; }
    setOperation(value); setError(null);
  };

  async function consult() {
    if (!client || !catalog?.available || locked || !question.trim() || problems.length) return;
    const lease = scope.begin('operation');
    if (!lease) return;
    const id = crypto.randomUUID();
    remember(id); setBusy('consult'); setError(null); setOperation(null);
    try {
      const received = await client.consult({ operationId: id, ...requestFields }, lease.signal);
      if (lease.current()) apply(received);
    } catch (cause) { if (lease.current()) setError(publicError(cause)); }
    finally { if (lease.finish()) setBusy(null); }
  }
  async function recover() {
    if (!client || !operationId || busy) return;
    const lease = scope.begin('operation');
    if (!lease) return;
    setBusy('status'); setError(null);
    try { const received = await client.status(operationId, lease.signal); if (lease.current()) apply(received); }
    catch (cause) { if (lease.current()) setError(publicError(cause)); }
    finally { if (lease.finish()) setBusy(null); }
  }
  async function cancel() {
    if (!client || !operationId || busy === 'cancel') return;
    scope.cancel('operation');
    const lease = scope.begin('operation');
    if (!lease) return;
    setBusy('cancel'); setError(null);
    try { const received = await client.cancel(operationId, lease.signal); if (lease.current()) apply(received); }
    catch { if (lease.current()) setError('L’annulation n’a pas été confirmée. Actualisez l’état de la consultation.'); }
    finally { if (lease.finish()) setBusy(null); }
  }

  const result = operation?.result;
  const citations = new Set(result?.answer ? result.citedSourceIds : []);
  const citedSources = result?.sources.filter(source => citations.has(source.id)) ?? [];
  const additionalSources = result?.sources.filter(source => !citations.has(source.id)) ?? [];
  return <section aria-label="Analyse approfondie PURAMA" className="min-h-0 flex-1 overflow-y-auto px-4 py-3 space-y-4">
    <div>
      <h4 className="font-medium">Analyse approfondie PURAMA</h4>
      <p className="text-xs text-muted-foreground mt-1">PURAMA analyse votre question avec les capacités disponibles. L’historique du chat n’est pas transmis à cette consultation.</p>
    </div>
    {catalogError ? <p role="alert" className="text-sm text-destructive">{catalogError}</p>
      : !catalog ? <p role="status" className="text-sm">Chargement des capacités…</p>
      : <p role="status" className="text-sm">{availabilityLabels[catalog.reason]}</p>}
    <form onSubmit={event => { event.preventDefault(); void consult(); }} className="space-y-3">
      <fieldset disabled={!catalog?.available || locked} className="space-y-3">
        {(councilOffer || activeCouncil) && <div className="space-y-1">
          <button type="button" aria-pressed={!!activeCouncil} className={buttonClass + ' aria-pressed:bg-accent'}
            onClick={() => setCouncil(activeCouncil ? null : councilOffer)}>Conseil IAO</button>
          <p className="text-xs text-muted-foreground">{activeCouncil
            ? `À l’envoi, ${activeCouncil.reviewerModels.length + 1} modèles recevront votre question et les sources choisies, puis confronteront leurs avis. Cette analyse peut consommer davantage de quota.`
            : 'Comparer plusieurs avis et obtenir une synthèse pour cette question.'}</p>
        </div>}
        {technicalDetails && <details className="rounded-md border border-border p-2 space-y-3">
          <summary className="cursor-pointer text-xs font-medium">Réglages techniques du fondateur</summary>
          <label className="block text-xs font-medium">Modèle principal
            <select aria-label="Modèle principal" value={model} onChange={event => setModel(event.target.value)} className={fieldClass}>
              {!selected && <option value={model} disabled>{model || 'Aucun modèle disponible'}</option>}
              {catalog?.models.map(item => <option key={item.model} value={item.model}>{item.model} · {providerLabels[item.provider] ?? item.provider}</option>)}
            </select>
          </label>
          {selected && <p className="text-xs text-muted-foreground">Fournisseur : {providerLabels[selected.provider] ?? selected.provider}. Ce modèle est proposé pour cette consultation.</p>}
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs font-medium">Réflexion
              <select aria-label="Réflexion de la consultation" value={reflection} onChange={event => setReflection(event.target.value as ConsultationReflection)} className={fieldClass}>
                {!selected?.reflections.includes(reflection) && <option value={reflection} disabled>{reflectionLabels[reflection]} — indisponible</option>}
                {selected?.reflections.map(value => <option key={value} value={value}>{reflectionLabels[value]}</option>)}
              </select>
            </label>
            <label className="text-xs font-medium">Vitesse
              <select aria-label="Vitesse de la consultation" value={speed} onChange={event => setSpeed(event.target.value as ConsultationSpeed)} className={fieldClass}>
                {!selected?.speeds.includes(speed) && <option value={speed} disabled>{speedLabels[speed]} — indisponible</option>}
                {selected?.speeds.map(value => <option key={value} value={value}>{speedLabels[value]}</option>)}
              </select>
            </label>
          </div>
          <p className="text-xs text-muted-foreground">Une vitesse plus élevée limite le temps accordé. Elle ne change pas le modèle ni la réflexion choisie et ne garantit pas un délai.</p>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium mb-1">Avis supplémentaires — facultatifs{profile ? ` (maximum ${profile.research.maxReviewers})` : ''}</legend>
            {catalog?.models.filter(item => item.model !== model || reviewers.includes(item.model)).map(item => <label key={item.model} className="flex items-start gap-2 text-xs break-all">
              <input type="checkbox" className="mt-0.5" checked={reviewers.includes(item.model)}
                disabled={!reviewers.includes(item.model) && (!profile || reviewers.length >= profile.research.maxReviewers
                  || !item.profiles.some(variant => variant.reflection === reflection && variant.speed === speed))}
                onChange={event => setReviewers(current => event.target.checked ? [...current, item.model] : current.filter(name => name !== item.model))} />
              <span>{item.model} · {providerLabels[item.provider] ?? item.provider}{item.model === model ? ' — déjà principal, retirer cet avis' : ''}</span>
            </label>)}
          </fieldset>
        </details>}
        <label className="block text-xs font-medium">Question
          <textarea aria-label="Question de consultation" value={question} onChange={event => setQuestion(event.target.value)} rows={3} maxLength={8000} className={fieldClass} />
        </label>
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">Recherche publique facultative</summary>
          <p className="text-xs text-muted-foreground mt-2">Seuls les textes et adresses ci-dessous sont envoyés aux services de recherche. N’y placez pas d’informations privées.</p>
          {!catalog?.research.search && <p className="text-xs mt-2">Recherche web indisponible.</p>}
          <label className="block text-xs mt-2">Requêtes publiques, une par ligne
            <textarea aria-label="Requêtes publiques" value={queries} onChange={event => setQueries(event.target.value)} rows={2} className={fieldClass} />
          </label>
          {!catalog?.research.scrape && <p className="text-xs mt-2">Lecture des pages indisponible.</p>}
          <label className="block text-xs mt-2">Pages HTTPS, une par ligne
            <textarea aria-label="Pages HTTPS" value={urls} onChange={event => setUrls(event.target.value)} rows={2} className={fieldClass} />
          </label>
        </details>
      </fieldset>
      {problems.length > 0 && <ul role="alert" className="text-xs text-destructive space-y-1">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul>}
      {!operationId && <button type="submit" className={`${buttonClass} bg-primary text-primary-foreground w-full`}
        disabled={!catalog?.available || locked || !question.trim() || problems.length > 0}>Lancer la consultation</button>}
    </form>
    {operationId && <div className="space-y-2">
      <p role="status" className="text-sm">{busy === 'consult' ? 'Consultation en cours…' : busy === 'status' ? 'Actualisation de l’état…'
        : busy === 'cancel' ? 'Annulation en cours…' : operation ? operationLabels[operation.status] : 'L’état de cette demande reste à confirmer.'}</p>
      {operation?.cancelRequested && operation.status !== 'cancelled' && <p className="text-xs">Annulation demandée. Un appel déjà parti peut avoir consommé des ressources.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy !== null} onClick={() => { void recover(); }}>Actualiser l’état</button>
        {(!operation || operation.status === 'running') && <button type="button" className={buttonClass} disabled={busy === 'cancel'} onClick={() => { void cancel(); }}>Arrêter la consultation</button>}
        {operation && operation.status !== 'running' && <button type="button" className={buttonClass} disabled={busy !== null}
          onClick={() => { remember(null); setOperation(null); setError(null); setQuestion(''); setCouncil(null); }}>Nouvelle consultation</button>}
      </div>
      <p className="text-xs text-muted-foreground">L’actualisation consulte le suivi de la demande. Un appel déjà parti peut avoir consommé des ressources.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {result && <article aria-label="Résultat de consultation" className="space-y-3 border-t border-border pt-3">
      {technicalDetails && <p className="text-xs text-muted-foreground">Modèle : {result.plan.model} · {reflectionLabels[result.plan.reflection]} · {speedLabels[result.plan.speed]}</p>}
      {result.answer && <p className="text-sm whitespace-pre-wrap break-words">{result.answer}</p>}
      {!result.answer && <p className="text-sm">Aucune réponse exploitable n’a été reçue.</p>}
      {result.answer && <p className="text-xs font-medium">
        {citedSources.length === 0 && 'Aucune citation reliée à une source recueillie. '}
        La vérification indépendante des faits reste à faire.
      </p>}
      {result.disagreements.length > 0 && <div><h5 className="text-sm font-medium">Désaccords</h5><ul className="list-disc pl-4 text-sm">{result.disagreements.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {result.uncertainties.length > 0 && <div><h5 className="text-sm font-medium">Incertitudes</h5><ul className="list-disc pl-4 text-sm">{result.uncertainties.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      {citedSources.length > 0 && <div>
        <h5 className="text-sm font-medium">Sources citées ({citedSources.length})</h5>
        <ConsultationSources sources={citedSources} technicalDetails={technicalDetails} />
      </div>}
      {additionalSources.length > 0 && <details className="text-xs">
        <summary className="cursor-pointer font-medium">Sources recueillies sans citation ({additionalSources.length})</summary>
        <ConsultationSources sources={additionalSources} technicalDetails={technicalDetails} />
      </details>}
    </article>}
  </section>;
}

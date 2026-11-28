import { useCallback, useEffect, useLayoutEffect, useState, type FormEvent } from 'react';
import { createRequestScope } from '@/lib/request-scope';
import { fetchInboxReviews, followupLabels, gmailReviewUrl, resolveInboxReview, type InboxReview, type Resolution } from '@/lib/email-inbox-review';

export default function EmailInboxReviews({ userId }: { userId: string }) {
  // Parent keys the component on authenticated owner and current mailbox.
  const [requests] = useState(createRequestScope);
  const [items,setItems] = useState<InboxReview[]>([]);
  const [next,setNext] = useState<string | null>(null);
  const [busy,setBusy] = useState(false);
  const [requiresRefresh,setRequiresRefresh] = useState(false);
  const [status,setStatus] = useState('');
  const [loaded,setLoaded] = useState(false);
  const [selected,setSelected] = useState('');
  useLayoutEffect(() => () => requests.invalidate(),[requests,userId]);

  const load = useCallback(async(cursor: string | null) => {
    const request = requests.begin('inbox-review');
    if (!request) return;
    setBusy(true);
    setSelected('');
    try {
      const result = await fetchInboxReviews(userId,cursor,request.signal);
      if (!request.current()) return;
      setItems(result.items); setNext(result.next);
      setLoaded(true); setRequiresRefresh(false); setStatus('');
    } catch {
      if (request.current()) { setStatus('Lecture indisponible. Actualisez les vérifications.'); setRequiresRefresh(true); }
    } finally { if (request.finish()) setBusy(false); }
  },[requests,userId]);
  useEffect(() => { void load(null); },[load]);

  async function resolve(event: FormEvent<HTMLFormElement>, item: InboxReview) {
    event.preventDefault();
    if (requiresRefresh || selected !== item.item_id) return;
    const data = new FormData(event.currentTarget);
    const resolution = data.get('resolution');
    const proof = String(data.get('proof') ?? '').trim();
    if ((resolution !== 'observed' && resolution !== 'closed_without_retry') || !data.has('checked') || !proof) return;
    const request = requests.begin('inbox-review');
    if (!request) return;
    setBusy(true);
    try {
      await resolveInboxReview(userId,item,resolution as Resolution,proof,request.signal);
      if (!request.current()) return;
      setItems(rows => rows.filter(row => row.item_id !== item.item_id)); setSelected('');
      setStatus('Vérification enregistrée. Aucun message envoyé.');
    } catch {
      if (request.current()) {
        setRequiresRefresh(true); setSelected('');
        setStatus('Clôture non confirmée. Actualisez la liste avant toute autre décision.');
      }
    } finally { if (request.finish()) setBusy(false); }
  }

  return <section aria-label="Vérifications Gmail" className="space-y-3 rounded-xl border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-semibold">Vérifications Gmail</h2>
      <button className="rounded border border-border px-3 py-2" disabled={busy} onClick={() => void load(null)}>Actualiser les vérifications</button>
    </div>
    {busy && <p role="status">Vérification en cours…</p>}
    {status && <p role="status">{status}</p>}
    {loaded && !items.length && !requiresRefresh && <p>{next ? 'Cette page a été traitée.' : 'Aucune référence à vérifier sur cette page.'}</p>}
    {items.map(item => {
      const url = gmailReviewUrl(item);
      const approval = item.reference?.startsWith('approval:');
      const receiptLabels: Record<string,string> = {message:'Message enregistré dans Gmail',draft:'Brouillon créé dans Gmail',approval:'Demande d’approbation enregistrée',notification:'Notification enregistrée'};
      const receiptType = item.reference?.split(':')[0];
      return <article key={item.item_id} className="space-y-2 rounded-lg border border-border p-3 break-words">
        <p><strong>{item.mailbox}</strong></p>
        <p className="break-all">Référence Gmail · {item.message_id}</p>
        {item.reference && <p className="break-all">{receiptLabels[receiptType ?? '']} · {item.reference}</p>}
        {!item.reference && <p>Effet initial à vérifier dans la boîte concernée.</p>}
        {item.followup_tools.length > 0 && <p>Suite à vérifier manuellement : {item.followup_tools.map(tool => followupLabels[tool]).join(', ')}.</p>}
        {approval && <p>Pour poursuivre l’action initiale, consultez le <a href="/dashboard/employees" className="underline">tableau des approbations</a> avant de clôturer.
          Clore ici met fin à la possibilité d’exécuter cette approbation si elle est encore en attente.</p>}
        {url && <a className="inline-block underline" href={url} target="_blank" rel="noreferrer noopener">Ouvrir Gmail pour {item.mailbox}</a>}
        {selected !== item.item_id ? <div><button disabled={busy || requiresRefresh} className="rounded border border-border px-3 py-2" onClick={() => setSelected(item.item_id)}>Consigner la vérification</button></div>
          : <form onSubmit={event => void resolve(event,item)} className="grid gap-3">
            <label>Résultat constaté<select className="block w-full rounded border bg-background p-2" name="resolution" required defaultValue="">
              <option value="" disabled>Choisir le résultat</option>
              <option value="observed">Effet constaté dans Gmail</option>
              <option value="closed_without_retry">Clore sans nouvelle tentative</option>
            </select></label>
            <label>Référence de votre vérification<input name="proof" className="block w-full rounded border bg-background p-2" maxLength={256} required placeholder="Ex. identifiant du message constaté" /></label>
            <label><input type="checkbox" name="checked" required /> J’ai vérifié cette référence dans la boîte {item.mailbox}.</label>
            <p className="text-sm text-muted-foreground">Cette clôture inscrit votre constat. Elle ne déclenche aucun renvoi.</p>
            <div className="flex flex-wrap gap-3"><button disabled={busy || requiresRefresh} className="rounded border border-border px-3 py-2">Confirmer la clôture</button>
              <button type="button" disabled={busy} onClick={() => setSelected('')}>Annuler</button></div>
          </form>}
      </article>;
    })}
    {next && <button disabled={busy || requiresRefresh} onClick={() => void load(next)}>Références suivantes</button>}
  </section>;
}

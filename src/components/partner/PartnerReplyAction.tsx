import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useRequestScope, useScopedState } from '@/hooks/useRequestScope';
import type { PartnerProspect } from '@/lib/partner';
import { preparePartnerReply, partnerReplyPreparationMessage, type PartnerReplyIntent,
  type PartnerReplyPreparation } from '@/lib/partner-completion';

/** Preparing only creates a local draft; the Email Agent owns preview and send. */
export function PartnerReplyAction({ prospect }: { prospect: PartnerProspect }) {
  const { user } = useAuth();
  const messageId = prospect.reply_gmail_message_id;
  const scopeKey = `${user?.id}:${prospect.id}:${messageId}:${prospect.updated_at}`;
  const capture = useRequestScope(scopeKey);
  const [intent, setIntent] = useScopedState<PartnerReplyIntent>(scopeKey, 'request_details');
  const [busy, setBusy] = useScopedState(scopeKey, false);
  const [result, setResult] = useScopedState<PartnerReplyPreparation | null>(scopeKey, null);
  const [error, setError] = useScopedState(scopeKey, '');
  const operation = useRef<AbortController | null>(null);
  useEffect(() => {
    setIntent('request_details'); setBusy(false); setResult(null); setError('');
    return () => { operation.current?.abort(); operation.current = null; };
  }, [scopeKey, setBusy, setError, setIntent, setResult]);
  const eligible = user?.id === prospect.user_id && prospect.reply_kind === 'human'
    && typeof messageId === 'string' && messageId.length > 0
    && !['rejected', 'inactive'].includes(prospect.status);
  const prepare = async () => {
    if (!eligible || !user || !messageId || operation.current) return;
    const current = capture();
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true); setError(''); setResult(null);
    try {
      const prepared = await preparePartnerReply(user.id, prospect.id, messageId, intent, controller.signal);
      if (current()) setResult(prepared);
    } catch (reason) {
      if (current()) setError(reason instanceof Error ? reason.message : 'La préparation n’a pas pu être confirmée.');
    } finally {
      if (operation.current === controller) operation.current = null;
      if (current()) setBusy(false);
    }
  };
  if (!eligible) return null;
  return <div className="mt-3 space-y-2 text-xs">
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1" htmlFor={`partner-reply-${prospect.id}`}>
        <span className="block text-muted-foreground">Suite à donner à la réponse</span>
        <select id={`partner-reply-${prospect.id}`} className="rounded-md border border-border bg-card px-2 py-2 text-foreground"
          value={intent} disabled={busy} onChange={event => { setIntent(event.target.value as PartnerReplyIntent); setResult(null); setError(''); }}>
          <option value="request_details">Demander des précisions</option>
          <option value="share_offer">Rappeler l’offre qualifiée</option>
        </select>
      </label>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void prepare()}>
        {busy ? 'Préparation…' : 'Préparer une réponse'}
      </Button>
    </div>
    <p className="text-muted-foreground">Le texte sera présenté dans la messagerie pour relecture et approbation avant envoi.</p>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {result && <div role="status" className="space-y-1">
      <p>{partnerReplyPreparationMessage(result)}</p>
      {(result.status === 'prepared' || result.status === 'existing') && <Link className="underline"
        to={`/dashboard/email-agent/logs?log=${result.log_id}`}>Ouvrir le brouillon et vérifier son état</Link>}
    </div>}
  </div>;
}

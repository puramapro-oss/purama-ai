import { supabase } from '@/integrations/supabase/client';

export type Resolution = 'observed' | 'closed_without_retry';
export const followupLabels = {
  gmail_send: 'Envoi d’un message',
  gmail_create_draft: 'Création d’un brouillon',
  send_notification: 'Notification',
} as const;
export type InboxReview = { item_id: string; mailbox: string; message_id: string; thread_id: string | null;
  reference: string | null; followup_tools: (keyof typeof followupLabels)[] };
type ReviewPage = { items: InboxReview[]; next: string | null };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const hasControl = (value: string) => Array.from(value).some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const safeMailbox = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 320 && !hasControl(value) && /^[^\s@]+@[^\s@]+$/u.test(value);

export function gmailReviewUrl(item: InboxReview) {
  if (!safeMailbox(item.mailbox)) return null;
  const url = new URL('https://mail.google.com/mail/');
  url.searchParams.set('authuser', item.mailbox);
  url.hash = item.thread_id && /^[0-9a-f]{1,64}$/i.test(item.thread_id) ? 'all/' + item.thread_id : 'all';
  return url.toString();
}

type Rpc = { rpc(name: string, args: Record<string, unknown>): {
  setHeader(name: string, value: string): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
  };
}};
async function reviewRpc(userId: string, name: string, args: Record<string, unknown>, signal: AbortSignal) {
  const { data, error } = await supabase.auth.getSession();
  if (signal.aborted || error || !data.session?.access_token || data.session.user.id !== userId) throw new Error('Session indisponible.');
  const response = await (supabase as unknown as Rpc).rpc(name,args)
    .setHeader('Authorization', 'Bearer ' + data.session.access_token).abortSignal(signal);
  if (signal.aborted || response.error || !response.data || typeof response.data !== 'object') throw new Error('Résultat indisponible.');
  return response.data as Record<string, unknown>;
}

export async function fetchInboxReviews(userId: string, cursor: string | null, signal: AbortSignal): Promise<ReviewPage> {
  if (cursor !== null && !uuid.test(cursor)) throw new Error('Page invalide.');
  const page = await reviewRpc(userId,'gmail_inbox_reviews',{ p_before_id:cursor },signal);
  if (page.status !== 'ok' || !Array.isArray(page.items) || page.items.length > 30
    || !(page.next_before_id === null || typeof page.next_before_id === 'string' && uuid.test(page.next_before_id))) throw new Error('Liste non confirmée.');
  const items = page.items.map(item => {
    if (!item || !uuid.test(item.item_id) || !safeMailbox(item.mailbox) || typeof item.message_id !== 'string' || !item.message_id.trim()
      || item.message_id.length > 256 || !(item.thread_id === null || typeof item.thread_id === 'string')
      || !(item.reference === null || typeof item.reference === 'string' && /^(?:message|draft|approval|notification):[A-Za-z0-9_-]{1,256}$/.test(item.reference))
      || !Array.isArray(item.followup_tools) || item.followup_tools.length > 3
      || new Set(item.followup_tools).size !== item.followup_tools.length
      || !item.followup_tools.every((tool: unknown) => typeof tool === 'string' && Object.prototype.hasOwnProperty.call(followupLabels,tool))) throw new Error('Référence invalide.');
    return {item_id:item.item_id, mailbox:item.mailbox, message_id:item.message_id, thread_id:item.thread_id,
      reference:item.reference, followup_tools:item.followup_tools} as InboxReview;
  });
  return {items, next: page.next_before_id as string | null};
}

export async function resolveInboxReview(userId: string, item: InboxReview, resolution: Resolution, proof: string, signal: AbortSignal) {
  const reference = proof.trim();
  if (!uuid.test(item.item_id) || !safeMailbox(item.mailbox) || !['observed','closed_without_retry'].includes(resolution)
    || !reference || reference.length > 256 || hasControl(reference)) throw new Error('Référence de vérification invalide.');
  const result = await reviewRpc(userId,'gmail_inbox_resolve',{
    p_item_id:item.item_id, p_expected_mailbox:item.mailbox, p_resolution:resolution, p_reference:reference,
  },signal);
  if (result.status !== resolution || result.item_id !== item.item_id) throw new Error('La clôture n’est pas confirmée.');
}

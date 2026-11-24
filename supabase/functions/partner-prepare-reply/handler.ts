import type { DraftSenderDependencies } from '../email-agent-send-draft/handler.ts';
import { readApprovedParent } from '../email-agent-send-draft/draft-snapshot.ts';
import { readBoundedBytes, readRequestText, RequestBodyError } from '../_shared/request-body.ts';
import { classifyPartnerReply, verifiedReplyMetadata } from '../partner-sync-replies/handler.ts';
import { buildPartnerReplyDraft, type ReplyIntent } from './draft.ts';
import { completeReplyText, hasReplyControls, replyAddress, replyHeader } from './reply-message.ts';

type Row = Record<string, unknown>;
export type PartnerReplyDraftDependencies = Pick<DraftSenderDependencies,
  'authenticate' | 'prepareAccess' | 'rpc' | 'fetch'>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{1,512}$/;
const rfc = /^<[^<>\s@]+@[^<>\s@]+>$/;
const object = (value: unknown): Row | null => value !== null && typeof value === 'object'
  && !Array.isArray(value) ? value as Row : null;
const cors = { 'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
const blocked = (reason: string, status = 200) => json({ status: 'blocked', reason }, status);
type ReplyContext = { prospect: Row; config: Row; snapshot: Row; receipt: {
  id: string; gmail_message_id: string; gmail_thread_id: string; rfc_message_id: string; received_at: string;
}; outbound: {
  action_id: string; prospect_id: string; provider_message_id: string; recipient: string; sender: string;
  reply_to: string; subject: string; sent_at: string; rfc_message_id: string; reply_scan_page_token: null;
}; connectionEmail: string; connectionUpdatedAt: string };
function context(value: Row, prospectId: string, messageId: string): ReplyContext {
  const prospect = object(value.prospect), config = object(value.config), snapshot = object(value.policy_snapshot);
  const receipt = object(value.receipt), outbound = object(value.outbound);
  if (!prospect || !config || !snapshot || !receipt || !outbound || prospect.id !== prospectId
    || receipt.gmail_message_id !== messageId || receipt.kind !== 'human'
    || typeof receipt.id !== 'string' || !uuid.test(receipt.id)
    || typeof receipt.gmail_thread_id !== 'string' || !opaque.test(receipt.gmail_thread_id)
    || typeof receipt.rfc_message_id !== 'string' || !rfc.test(receipt.rfc_message_id)
    || typeof receipt.received_at !== 'string' || !Number.isFinite(Date.parse(receipt.received_at))
    || typeof outbound.action_id !== 'string' || !uuid.test(outbound.action_id)
    || outbound.prospect_id !== prospectId || typeof outbound.provider_message_id !== 'string' || !opaque.test(outbound.provider_message_id)
    || !replyAddress(outbound.recipient) || replyAddress(outbound.recipient) !== replyAddress(prospect.email)
    || !replyAddress(outbound.sender) || !replyAddress(outbound.reply_to)
    || typeof outbound.subject !== 'string' || hasReplyControls(outbound.subject)
    || typeof outbound.sent_at !== 'string' || !Number.isFinite(Date.parse(outbound.sent_at))
    || typeof outbound.rfc_message_id !== 'string' || !rfc.test(outbound.rfc_message_id)
    || outbound.reply_scan_page_token !== null
    || typeof value.connection_email !== 'string' || !replyAddress(value.connection_email)
    || replyAddress(outbound.reply_to) !== replyAddress(value.connection_email)
    || typeof value.connection_updated_at !== 'string' || !Number.isFinite(Date.parse(value.connection_updated_at))) {
    throw new Error('reply_context_unverified');
  }
  return { prospect, config, snapshot, receipt: receipt as ReplyContext['receipt'],
    outbound: outbound as ReplyContext['outbound'], connectionEmail: value.connection_email,
    connectionUpdatedAt: value.connection_updated_at };
}

/** Prepare a local, reviewable reply. There is deliberately no Gmail write or
 * model call: incoming content is displayed as evidence, never instructions. */
export function createPartnerReplyDraftHandler(deps: PartnerReplyDraftDependencies) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (req.headers.has('X-Impersonate-User-Id')) return blocked('user_action_required', 403);
    let userId: string;
    try {
      const auth = req.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i);
      const identity = auth ? await deps.authenticate(auth[1]) : null;
      if (!identity || !uuid.test(identity)) return json({ error: 'Unauthorized' }, 401);
      userId = identity;
    } catch { return blocked('authentication_unavailable', 503); }
    let input: Row | null;
    try { input = object(JSON.parse(await readRequestText(req, { maxBytes: 4096, timeoutMs: 3000 }))); }
    catch (error) { return json({ error: 'Invalid request' }, error instanceof RequestBodyError ? error.status : 400); }
    if (!input || Object.keys(input).some(key => !['prospect_id', 'gmail_message_id', 'intent'].includes(key))
      || typeof input.prospect_id !== 'string' || !uuid.test(input.prospect_id)
      || typeof input.gmail_message_id !== 'string' || !opaque.test(input.gmail_message_id)
      || typeof input.intent !== 'string' || !['request_details', 'share_offer'].includes(input.intent)) return json({ error: 'Invalid request' }, 400);
    const prospectId = input.prospect_id, messageId = input.gmail_message_id, intent = input.intent as ReplyIntent;
    const call = async (name: string, args: Row): Promise<Row> => {
      const result = await deps.rpc(name, args), data = object(result.data);
      if (result.error || !data) throw new Error('reply_storage_unavailable');
      return data;
    };
    let current: ReplyContext;
    try {
      const loaded = await call('partner_reply_draft_context', {
        p_user_id: userId, p_prospect_id: prospectId, p_gmail_message_id: messageId,
      });
      if (loaded.status !== 'ready') return blocked(typeof loaded.reason === 'string' ? loaded.reason : 'reply_context_unverified');
      current = context(loaded, prospectId, messageId);
    } catch { return blocked('reply_context_unavailable', 503); }
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(40_000)]);
    const deadline = performance.now() + 40_000;
    const readOnlyFetch: typeof fetch = async (url, init) => {
      if (init?.method && init.method !== 'GET' || signal.aborted || performance.now() >= deadline) {
        throw new Error('reply_content_unverified');
      }
      return deps.fetch(url, { ...init, redirect: 'error', signal: init?.signal
        ? AbortSignal.any([init.signal, signal]) : signal });
    };
    const get = async (url: string, accessToken: string, maxBytes: number): Promise<Row> => {
      const response = await readOnlyFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error('reply_content_unverified'); }
      const bytes = await readBoundedBytes({ body: response.body, headers: response.headers, signal }, {
        maxBytes, deadline, matchContentLength: false,
      });
      const result = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      if (!result) throw new Error('reply_content_unverified');
      return result;
    };
    let receivedSubject: string, receivedBody: string, subject: string, body: string;
    try {
      const access = await deps.prepareAccess(userId);
      if (!access.accessToken || replyAddress(access.gmailEmail) !== replyAddress(current.connectionEmail)
        || Date.parse(access.connectionUpdatedAt) !== Date.parse(current.connectionUpdatedAt)) throw new Error('reply_context_changed');
      const identity = await get('https://gmail.googleapis.com/gmail/v1/users/me/profile', access.accessToken, 64000);
      if (replyAddress(identity.emailAddress) !== replyAddress(current.connectionEmail)) throw new Error('mailbox_identity_unverified');
      const message = await get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, access.accessToken, 2_100_000);
      const metadata = verifiedReplyMetadata(message, messageId, current.outbound, current.outbound.rfc_message_id);
      if (!metadata || metadata.kind !== 'human' || metadata.gmail_thread_id !== current.receipt.gmail_thread_id
        || metadata.rfc_message_id !== current.receipt.rfc_message_id
        || Date.parse(String(metadata.received_at)) !== Date.parse(current.receipt.received_at)) throw new Error('reply_receipt_changed');
      receivedBody = completeReplyText(message.payload);
      // Classify the complete verified first line, independently of the total
      // MIME body size accepted by the older reply scanner. A long quoted tail
      // must not hide an explicit standalone "unsubscribe" at the beginning.
      const firstLine = receivedBody.split(/\r?\n/).find(line => line.trim())?.trim() ?? '';
      if (firstLine.length > 4000) throw new Error('reply_content_unverified');
      let binary = '';
      for (const byte of new TextEncoder().encode(firstLine)) binary += String.fromCharCode(byte);
      const data = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (classifyPartnerReply(metadata, { mimeType: 'text/plain', body: { data } }) !== 'human') {
        throw new Error('contact_suppressed');
      }
      receivedSubject = replyHeader(message.payload, 'subject', true);
      if (!receivedSubject || receivedSubject.includes('=?') || receivedSubject.length > 998) throw new Error('reply_content_unverified');
      subject = /^(?:re:\s*)/i.test(receivedSubject) ? receivedSubject : `Re: ${receivedSubject}`;
      // The generic sender uses a single MIME header line; enforce that limit
      // before storing a draft instead of leaving an unsendable preview.
      const headerLength = /^[\x20-\x7E]*$/.test(subject) ? subject.length
        : 12 + Math.ceil(new TextEncoder().encode(subject).byteLength / 3) * 4;
      if (headerLength > 970) throw new Error('reply_content_unverified');
      const parent = await readApprovedParent(async url => new Response(JSON.stringify(
        await get(String(url), access.accessToken, 128000),
      )), access.accessToken, {
        gmail_message_id: messageId, gmail_thread_id: current.receipt.gmail_thread_id,
        recipient: current.outbound.recipient, subject,
      });
      if (parent.rfcId !== current.receipt.rfc_message_id) throw new Error('reply_receipt_changed');
      body = buildPartnerReplyDraft(current.prospect, current.config, intent);
    } catch (error) {
      const known = ['reply_context_changed', 'mailbox_identity_unverified', 'reply_receipt_changed',
        'contact_suppressed', 'outreach_language_unsupported', 'offer_required', 'media_profile_required'];
      return blocked(error instanceof Error && known.includes(error.message) ? error.message : 'reply_content_unverified');
    }
    if (signal.aborted || performance.now() >= deadline) return blocked('reply_content_unverified');
    try {
      const saved = await call('partner_reply_draft_save', {
        p_user_id: userId, p_prospect_id: prospectId, p_gmail_message_id: messageId,
        p_receipt_id: current.receipt.id, p_policy_snapshot: current.snapshot,
        p_connection_email: current.connectionEmail, p_connection_updated_at: current.connectionUpdatedAt,
        p_intent: intent, p_subject: subject, p_body: body,
        p_received_subject: receivedSubject, p_received_body: receivedBody,
      });
      if (saved.status === 'blocked') return blocked(typeof saved.reason === 'string' ? saved.reason : 'reply_context_changed');
      if (typeof saved.status !== 'string' || !['prepared', 'existing'].includes(saved.status) || typeof saved.log_id !== 'string'
        || !uuid.test(saved.log_id) || typeof saved.intent !== 'string'
        || !['request_details', 'share_offer', 'existing'].includes(saved.intent)) {
        throw new Error('reply_draft_outcome_unconfirmed');
      }
      return json({ status: saved.status, user_id: userId, prospect_id: prospectId,
        gmail_message_id: messageId, log_id: saved.log_id, intent: saved.intent });
    } catch {
      // The local transaction may have committed. A subsequent explicit request
      // reconciles its unique binding; never create another log to conceal this.
      return json({ status: 'unknown', reason: 'reply_draft_outcome_unconfirmed' }, 202);
    }
  };
}

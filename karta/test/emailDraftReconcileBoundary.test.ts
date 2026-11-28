import { afterEach, describe, expect, it, vi } from 'vitest';

// Pure handler tests: no SQL runtime, credentials, or live provider requests.
const handlerUrl = new URL('../../supabase/functions/email-agent-reconcile-draft/handler.ts', import.meta.url).href;
const { createDraftReconciler } = await import(/* @vite-ignore */ handlerUrl);
type Row = Record<string, unknown>;
const user = '00000000-0000-4000-8000-000000000001';
const log = '00000000-0000-4000-8000-000000000011';
const action = '00000000-0000-4000-8000-000000000021';
const owner = 'owner@example.invalid';
const payload = {
  gmail_message_id: 'incoming-1', gmail_thread_id: 'thread-1', gmail_draft_id: null,
  recipient: 'recipient@example.invalid', subject: 'Re: Approved subject',
  body: 'Approved body', gmail_email: owner,
};

function mime(extra = '', from = `From: ${owner}\r\n`): string {
  return Buffer.from(from + `To: ${payload.recipient}\r\nSubject: ${payload.subject}\r\n`
    + 'In-Reply-To: <parent@example.invalid>\r\nReferences: <parent@example.invalid>\r\n'
    + extra + 'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'
    + payload.body).toString('base64url');
}

type Options = {
  knownReceipt?: boolean;
  identity?: string;
  raw?: string;
  threadMessages?: Row[];
  message?: Row;
};

function harness(options: Options = {}) {
  const stamp = new Date(Date.now() - 10_000).toISOString();
  const rpc = vi.fn(async (name: string, args: Row) => ({ error: null, data:
    name === 'email_agent_reconcile_context'
      ? { status: 'unknown', eligible: true, action_id: action, payload,
        provider_message_id: options.knownReceipt === false ? null : 'sent-1',
        dispatch_started_at: stamp, dispatch_updated_at: stamp, matches_current_preview: true }
      : { status: 'sent', action_id: action, provider_message_id: args.p_provider_message_id,
        matches_current_preview: true },
  }));
  const prepareAccess = vi.fn(async () => ({
    accessToken: 'test-only-token', gmailEmail: owner, connectionUpdatedAt: stamp,
  }));
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect(init?.method).toBe('GET');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const url = String(input);
    if (url.endsWith('/profile')) return Response.json({ emailAddress: options.identity ?? owner });
    if (url.includes('/messages/incoming-1?format=metadata')) {
      return Response.json({ id: 'incoming-1', threadId: 'thread-1', payload: { headers: [
        { name: 'Message-ID', value: '<parent@example.invalid>' },
        { name: 'From', value: payload.recipient },
        { name: 'Subject', value: 'Approved subject' },
      ] } });
    }
    if (url.endsWith('/threads/thread-1?format=minimal')) {
      return Response.json({ id: 'thread-1', messages: options.threadMessages
        ?? [{ id: 'sent-1', labelIds: ['SENT'] }] });
    }
    const id = url.match(/\/messages\/([^/?]+)\?format=raw$/)?.[1];
    if (!id) throw new Error('Unexpected Gmail read');
    return Response.json({ id, threadId: 'thread-1', labelIds: ['SENT'],
      internalDate: String(Date.now()), raw: options.raw ?? mime(), ...options.message });
  });
  const handler: (request: Request) => Promise<Response> = createDraftReconciler({
    authenticate: async () => user, rpc, prepareAccess, fetch: fetcher,
  });
  return { handler, rpc, prepareAccess, fetcher };
}

function request(body: string | ReadableStream<Uint8Array> = JSON.stringify({ log_id: log }), signal?: AbortSignal): Request {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST',
    headers: { Authorization: 'Bearer test-only-token', 'Content-Type': 'application/json' },
    body, signal, duplex: 'half' };
  return new Request('https://example.invalid/reconcile', init);
}

function expectNoPreparation(h: ReturnType<typeof harness>): void {
  expect(h.rpc).not.toHaveBeenCalled();
  expect(h.prepareAccess).not.toHaveBeenCalled();
  expect(h.fetcher).not.toHaveBeenCalled();
}

function expectNoFinish(h: ReturnType<typeof harness>): void {
  expect(h.rpc.mock.calls.some(([name]) => name === 'email_agent_reconcile_finish')).toBe(false);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Gmail reconciliation request boundaries', () => {
  it('rejects an aborted body even after complete valid JSON bytes arrived without end of stream', async () => {
    const h = harness(), abort = new AbortController(), cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ log_id: log }))); },
      cancel,
    });
    const pending = h.handler(request(stream, abort.signal));
    await Promise.resolve();
    abort.abort();
    const response = await pending;
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expectNoPreparation(h);
  });

  it('enforces the five second body deadline without waiting for remote cancellation', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('Test deadline')), milliseconds);
      return controller.signal;
    });
    const h = harness(), cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ log_id: log }))); },
      cancel,
    });
    let settled = false;
    const pending = h.handler(request(stream)).then(response => { settled = true; return response; });
    await vi.advanceTimersByTimeAsync(4999);
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(settled).toBe(false);
    expectNoPreparation(h);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expectNoPreparation(h);
  });

  it('rejects an oversized body even if its cancellation acknowledgement never resolves', async () => {
    const h = harness(), cancel = vi.fn(() => new Promise<void>(() => {}));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(4097))); },
      cancel,
    });
    const response = await h.handler(request(stream));
    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expectNoPreparation(h);
  });
});

describe('Gmail reconciliation provider boundaries', () => {
  it.each([undefined, 'thread-1'])('accepts a minimal candidate with threadId %s only after verifying the raw message', async threadId => {
    const candidate: Row = { id: 'sent-1', labelIds: ['SENT'] };
    if (threadId) candidate.threadId = threadId;
    const h = harness({ knownReceipt: false, threadMessages: [candidate] });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'sent', reconciled: true });
    expect(h.fetcher).toHaveBeenCalledTimes(4);
    expect(h.rpc).toHaveBeenLastCalledWith('email_agent_reconcile_finish', expect.objectContaining({
      p_user_id: user, p_action_id: action, p_provider_message_id: 'sent-1',
      p_raw_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    }));
  });

  it('rejects an explicitly divergent thread in the minimal candidate', async () => {
    const h = harness({ knownReceipt: false,
      threadMessages: [{ id: 'sent-1', threadId: 'foreign-thread', labelIds: ['SENT'] }] });
    const response = await h.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'thread_evidence_incomplete' });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
    expectNoFinish(h);
  });

  it.each(['foreign-thread', undefined])('rejects a raw message with threadId %s despite a valid minimal candidate', async threadId => {
    const h = harness({ knownReceipt: false, message: { threadId } });
    expect((await h.handler(request())).status).toBe(409);
    expectNoFinish(h);
  });

  it('keeps an ambiguous pair of matching SENT messages unresolved', async () => {
    const h = harness({ knownReceipt: false,
      threadMessages: ['sent-1', 'sent-2'].map(id => ({ id, labelIds: ['SENT'] })) });
    const response = await h.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'multiple_matching_sent_messages' });
    expectNoFinish(h);
  });

  it.each([
    ['missing From', mime('', '')],
    ['duplicate From', mime(`From: ${owner}\r\n`)],
    ['different From', mime('', 'From: other@example.invalid\r\n')],
    ['resent recipient', mime('Resent-To: hidden@example.invalid\r\n')],
    ['additional Cc', mime('Cc: hidden@example.invalid\r\n')],
    ['additional Bcc', mime('Bcc: hidden@example.invalid\r\n')],
    ['different Sender', mime('Sender: other@example.invalid\r\n')],
  ])('rejects %s without confirming the dispatch', async (_name, raw) => {
    const h = harness({ raw });
    expect((await h.handler(request())).status).toBe(409);
    expectNoFinish(h);
  });

  it('refuses provider evidence from another Gmail account before reading message content', async () => {
    const h = harness({ identity: 'other@example.invalid' });
    const response = await h.handler(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'gmail_identity_mismatch' });
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expectNoFinish(h);
  });

  it('confirms a known receipt with a verified account and matching raw content', async () => {
    const h = harness({ identity: owner.toUpperCase() });
    const response = await h.handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider_message_id: 'sent-1', matches_current_preview: true });
    expect(h.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([['INBOX'], ['SENT', 'DRAFT']])('rejects raw message labels %j', async (...labelIds) => {
    const h = harness({ message: { labelIds } });
    expect((await h.handler(request())).status).toBe(409);
    expectNoFinish(h);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsultationClientError, consultationSourceUrl, createConsultationClient, type ConsultationInput } from './consultation-client';
import { catalogFixture, deferred, operationFixture, OPERATION, OTHER_OPERATION } from '@/test/consultation-fixtures';

const network = vi.fn();
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const wireBody = (index: number) => JSON.parse(network.mock.calls[index][1].body);
const request = (): ConsultationInput => ({ operationId: OPERATION, question: 'Une question privée.',
  preferences: { model: 'primary-model', reflection: 'maximum', speed: 'standard' },
  reviewerModels: ['reviewer-model'], research: { queries: ['Une requête publique.'], urls: ['https://example.com/public'] },
});
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('fetch', network);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-key');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('consultation client boundary', () => {
  it('sends only the explicit request, captures the account token, and looks up the same operation', async () => {
    const first = createConsultationClient('first-account-token');
    const second = createConsultationClient('second-account-token');
    const controller = new AbortController();
    network.mockImplementation(async () => respond({ ok: true, operation: operationFixture() }));
    await first.consult(request(), controller.signal);
    expect(network).toHaveBeenNthCalledWith(1, 'https://project.supabase.co/functions/v1/iao-consultation', {
      body: JSON.stringify({ action: 'consult', ...request() }), headers: { Authorization: 'Bearer first-account-token', apikey: 'public-key', 'Content-Type': 'application/json' }, signal: controller.signal,
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    });
    await first.status(OPERATION);
    await second.cancel(OPERATION);
    expect(wireBody(1)).toEqual({ action: 'status', operationId: OPERATION });
    expect(wireBody(2)).toEqual({ action: 'cancel', operationId: OPERATION });
    expect(network.mock.calls[1][1].headers.Authorization).toBe('Bearer first-account-token');
    expect(network.mock.calls[2][1].headers.Authorization).toBe('Bearer second-account-token');
    expect(network.mock.calls.map(call => call[1].body).join('')).not.toMatch(/userId|history|budget|apiKey|token/);
  });

  it('accepts server profiles without inventing unsupported combinations and has no provider credentials', async () => {
    const catalog = catalogFixture();
    catalog.models[0].profiles.pop();
    network.mockResolvedValue(respond({ ok: true, catalog }));
    expect(await createConsultationClient('token').catalog()).toEqual(catalog);
    expect(wireBody(0)).toEqual({ action: 'catalog' });
  });

  it.each(['simulation_enabled', 'budget_unavailable', 'account_unavailable', 'model_unavailable', 'not_configured', 'paused', 'service_unavailable'] as const)(
    'preserves the exact unavailable catalogue reason %s', async reason => {
      const catalog = { ...catalogFixture(), available: false, reason, models: [] };
      network.mockResolvedValue(respond({ ok: true, catalog }));
      expect(await createConsultationClient('token').catalog()).toEqual(catalog);
    },
  );

  it('rejects forbidden authority fields and malformed input before any network request', async () => {
    const client = createConsultationClient('token');
    for (const value of [
      { ...request(), userId: 'other-user' }, { ...request(), budget: 1 },
      { ...request(), preferences: { model: 'primary-model', providerApiKey: 'secret' } },
      { ...request(), operationId: `${OPERATION}\n` },
      { ...request(), research: { queries: ['safe'], urls: ['javascript:alert(1)'] } },
      { ...request(), research: { queries: ['safe'], urls: ['https://name:password@example.com'] } },
      { ...request(), reviewerModels: ['primary-model'] },
    ]) await expect(client.consult(value as ConsultationInput)).rejects.toMatchObject({ code: 'invalid' });
    expect(network).not.toHaveBeenCalled();
  });

  it('rejects foreign operation responses, unsafe sources, private extra fields and unbound citations', async () => {
    const client = createConsultationClient('token');
    const wrong = operationFixture(OTHER_OPERATION);
    const source = operationFixture(); source.result!.sources[0].url = 'javascript:alert(1)';
    const hidden = { ...operationFixture(), userId: 'other-user', credential: 'secret' };
    const citation = operationFixture(); citation.result!.citedSourceIds = ['missing-source'];
    for (const operation of [wrong, source, hidden, citation]) {
      network.mockResolvedValueOnce(respond({ ok: true, operation }));
      await expect(client.status(OPERATION)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('rejects complete or partial operations without a matching nonempty result', async () => {
    const client = createConsultationClient('token');
    const empty = operationFixture(); empty.result!.answer = '  ';
    const mismatch = operationFixture(); mismatch.status = 'partial';
    const nullResult = operationFixture(); nullResult.result = null;
    const nullAnswer = operationFixture(); nullAnswer.result!.answer = null;
    const failedWithAnswer = operationFixture(); failedWithAnswer.result!.status = 'failed';
    for (const operation of [empty, mismatch, nullResult, nullAnswer, failedWithAnswer]) {
      network.mockResolvedValueOnce(respond({ ok: true, operation }));
      await expect(client.status(OPERATION)).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it('bounds UTF-8 bytes before JSON parsing even when Unicode character count is smaller', async () => {
    const content = JSON.stringify({ note: '界'.repeat(180000) });
    expect(content.length).toBeLessThan(524288);
    expect(new TextEncoder().encode(content).byteLength).toBeGreaterThan(524288);
    const cancel = vi.fn();
    const bytes = new TextEncoder().encode(content);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 262144)); controller.enqueue(bytes.subarray(262144)); }, cancel,
    });
    network.mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
    await expect(createConsultationClient('token').status(OPERATION)).rejects.toMatchObject({ code: 'invalid' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized outbound JSON before sending and missing endpoint configuration without using a relative URL', async () => {
    const oversized = request();
    oversized.question = '界'.repeat(8000);
    oversized.research = { queries: ['界'.repeat(2000), '界'.repeat(2000), '界'.repeat(2000)],
      urls: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}/${'a'.repeat(8100)}`) };
    await expect(createConsultationClient('token').consult(oversized)).rejects.toMatchObject({ code: 'invalid' });
    vi.stubEnv('VITE_SUPABASE_URL', '');
    await expect(createConsultationClient('token').catalog()).rejects.toMatchObject({ code: 'unavailable' });
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'IAO_AUTH', 'authentication'], [403, 'IAO_FORBIDDEN', 'forbidden'], [404, 'IAO_NOT_FOUND', 'not_found'],
    [409, 'IAO_CONFLICT', 'conflict'], [429, 'IAO_BUDGET', 'budget'], [429, 'IAO_RATE_LIMIT', 'rate_limit'],
    [499, 'IAO_CANCELLED', 'interrupted'], [504, 'IAO_TIMEOUT', 'timeout'], [503, 'IAO_UNAVAILABLE', 'unavailable'],
  ])('uses a safe precise error for HTTP %s / %s', async (status, code, expected) => {
    network.mockResolvedValue(respond({ code, error: 'secret provider credential' }, Number(status)));
    const error = await createConsultationClient('token').status(OPERATION).catch(error => error);
    expect(error).toBeInstanceOf(ConsultationClientError); expect(error.code).toBe(expected); expect(error.message).not.toContain('secret');
  });

  it('does not retry an uncertain request and permits status-only recovery', async () => {
    const client = createConsultationClient('token');
    network.mockRejectedValueOnce(new Error('network disconnect with secret'));
    await expect(client.consult(request())).rejects.toMatchObject({ code: 'unavailable' });
    expect(network).toHaveBeenCalledTimes(1);
    network.mockResolvedValueOnce(respond({ ok: true, operation: operationFixture() }));
    await client.status(OPERATION);
    expect(network.mock.calls.map((_call, index) => wireBody(index).action)).toEqual(['consult', 'status']);
  });

  it('stops aborted work before sending and rejects late completion after cancellation', async () => {
    const client = createConsultationClient('token');
    const controller = new AbortController(); controller.abort();
    await expect(client.consult(request(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(network).not.toHaveBeenCalled();
    const pending = deferred<Response>(); network.mockReturnValueOnce(pending.promise);
    const second = new AbortController(); const running = client.consult(request(), second.signal);
    second.abort(); pending.resolve(respond({ ok: true, operation: operationFixture() }));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(network).toHaveBeenCalledTimes(1);
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>x</script>', 'https://user:password@example.com', ' http://example.com', 'https://example.com\n', 'https://localhost'])('does not expose an unsafe source link: %s', value => {
    expect(consultationSourceUrl(value)).toBeNull();
  });
});

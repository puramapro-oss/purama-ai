import { FunctionsClient } from '@supabase/functions-js';
import { FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findProspects } from './partner';

const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: api.invoke } } }));
const failureBody = (status = 'unknown', confirmed = 1, code = 'discovery_timeout') => ({
  status, code, inserted: confirmed, confirmed_inserted: confirmed,
  prospects: Array.from({ length: confirmed }, (_, index) => ({ id: `confirmed-${index}` })),
  error: 'PRIVATE-PROVIDER-DIAGNOSTIC api_key=DO-NOT-DISPLAY',
});
function fixtureBody(value: string | Uint8Array): ReadableStream<Uint8Array> {
  // Node's native Response(string) emits Node-realm views, unlike this JSDOM realm.
  // Keep a real Response/stream with browser-equivalent Uint8Array chunks.
  const bytes = new Uint8Array(typeof value === 'string' ? new TextEncoder().encode(value) : value);
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}
function httpFailure(body: unknown, status = 504) {
  return new Response(fixtureBody(JSON.stringify(body)), { status, headers: { 'Content-Type': 'application/json' } });
}
function rejectWith(response: Response) {
  api.invoke.mockResolvedValueOnce({ data: null, error: new FunctionsHttpError(response) });
}
async function rejected() {
  try { await findProspects('Sites spécialisés'); }
  catch (error) { return error as Error & { status: string; confirmedInserted: number | null }; }
  throw new Error('Expected a safe discovery failure');
}
beforeEach(() => {
  vi.resetAllMocks();
  api.invoke.mockResolvedValue({ data: { inserted: 0, prospects: [] }, error: null });
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected external request'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('partner discovery HTTP receipts and bounded public failures', () => {
  it('preserves an unknown confirmed count from a real FunctionsClient non-2xx error', async () => {
    const response = httpFailure(failureBody());
    const clone = vi.spyOn(response, 'clone');
    const sdk = new FunctionsClient('https://fixture.invalid/functions/v1', { customFetch: async () => response });
    api.invoke.mockImplementationOnce((name, options) => sdk.invoke(name, options));
    const error = await rejected();
    expect(error).toMatchObject({ name: 'PartnerDiscoveryError', status: 'unknown', confirmedInserted: 1 });
    expect(error.message).toContain('1 prospect est confirmé enregistré');
    expect(error.message).toContain('Vérifiez la liste des prospects avant de relancer');
    expect(error.message).not.toContain('PRIVATE-PROVIDER'); expect(error.message).not.toContain('api_key');
    expect(clone).not.toHaveBeenCalled(); expect(response.bodyUsed).toBe(true);
  });

  it('keeps confirmed partial writes without presenting the failed operation as a rollback', async () => {
    rejectWith(httpFailure(failureBody('partial', 2, 'prospect_storage_unavailable'), 503));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'partial', confirmedInserted: 2 });
    expect(error.message).toContain('2 prospects sont confirmés enregistrés');
    expect(error.message).toContain('avant de relancer');
    expect(error.message).not.toMatch(/annulés|aucun prospect|PRIVATE-PROVIDER|api_key/u);
  });

  it('maps a known pre-write failure to a fixed French message', async () => {
    rejectWith(httpFailure(failureBody('failed', 0, 'unauthorized'), 401));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'failed', confirmedInserted: 0 });
    expect(error.message).toBe('Reconnectez-vous avant de lancer une recherche de prospects.');
    expect(error.message).not.toContain('PRIVATE-PROVIDER');
  });

  it('explains a canonical targeting failure with a local actionable message', async () => {
    rejectWith(httpFailure(failureBody('failed', 0, 'discovery_targeting_required'), 409));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'failed', confirmedInserted: 0 });
    expect(error.message).toBe('Enregistrez les paramètres de pays et de langues avant de rechercher des prospects.');
    expect(error.message).not.toMatch(/PRIVATE-PROVIDER|api_key/u);
  });

  it('explains an unconfirmed canonical import without promising rollback', async () => {
    rejectWith(httpFailure(failureBody('unknown', 0, 'discovery_storage_unconfirmed'), 500));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: 0 });
    expect(error.message).toContain('Le résultat de l’enregistrement des prospects n’a pas pu être confirmé.');
    expect(error.message).toContain('Vérifiez la liste des prospects avant de relancer.');
    expect(error.message).not.toMatch(/annulés|aucun prospect|PRIVATE-PROVIDER|api_key/u);
  });

  it('keeps an unknown structured code local and never displays its arbitrary diagnostic', async () => {
    rejectWith(httpFailure(failureBody('unknown', 0, 'discovery_private_provider_debug_SECRET'), 503));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: 0 });
    expect(error.message).toContain('Le résultat de la recherche n’a pas pu être confirmé.');
    expect(error.message).toContain('Vérifiez la liste des prospects avant de relancer.');
    expect(error.message).not.toMatch(/SECRET|PRIVATE-PROVIDER|api_key|discovery_private/u);
  });

  it.each([
    { ...failureBody(), confirmed_inserted: -1 },
    { ...failureBody(), confirmed_inserted: 1.5 },
    failureBody('unknown', 26),
    { ...failureBody(), confirmed_inserted: '1' },
    { ...failureBody(), inserted: 2 },
    { ...failureBody('failed', 1) },
    { ...failureBody('partial', 0) },
    { ...failureBody(), status: 'all_good' },
    { ...failureBody(), status: ['unknown'] },
  ])('does not invent a confirmed count from an inconsistent receipt %#', async body => {
    rejectWith(httpFailure(body));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(error.message).toContain('Vérifiez la liste des prospects avant de relancer');
    expect(error.message).not.toContain('PRIVATE-PROVIDER');
  });

  it('does not infer a confirmed count from a legacy inserted field alone', async () => {
    rejectWith(httpFailure({ status: 'unknown', code: 'discovery_timeout', inserted: 7, error: 'PRIVATE' }));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(error.message).not.toContain('7 prospects');
  });

  it('hides an arbitrary thrown transport diagnostic and keeps the outcome unconfirmed', async () => {
    api.invoke.mockRejectedValueOnce(new Error('PRIVATE secret=unsafe-provider-detail'));
    const error = await rejected();
    expect(error).toMatchObject({ name: 'PartnerDiscoveryError', status: 'unknown', confirmedInserted: null });
    expect(error.message).toContain('avant de relancer');
    expect(error.message).not.toMatch(/PRIVATE|secret=/u);
  });

  it('cancels an unread relay body and never renders its diagnostics', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    api.invoke.mockResolvedValueOnce({ data: null, error: new FunctionsRelayError(new Response(body, { status: 503 })) });
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects declared oversized bodies without reading or cloning them', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body, { status: 503, headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } });
    const reader = vi.spyOn(body, 'getReader'); const clone = vi.spyOn(response, 'clone');
    rejectWith(response);
    expect(await rejected()).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(reader).not.toHaveBeenCalled(); expect(clone).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('bounds chunked bytes even when the advertised content length is absent', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8192)); controller.enqueue(new Uint8Array(8193)); }, cancel,
    });
    rejectWith(new Response(body, { status: 503, headers: { 'Content-Type': 'application/json' } }));
    expect(await rejected()).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('stops a stalled original body within the local deadline even if cancellation never resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const body = new ReadableStream<Uint8Array>({ cancel });
    rejectWith(new Response(body, { status: 504, headers: { 'Content-Type': 'application/json' } }));
    const pending = rejected();
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['text/html', new TextEncoder().encode('<html>PRIVATE-SECRET</html>')],
    ['application/json', new TextEncoder().encode('{"error":"PRIVATE-SECRET"')],
    ['application/json', new Uint8Array([0xff, 0xfe])],
  ])('rejects malformed or non-JSON error content safely (%s)', async (type, bytes) => {
    rejectWith(new Response(fixtureBody(bytes as Uint8Array), { status: 502, headers: { 'Content-Type': String(type) } }));
    const error = await rejected();
    expect(error).toMatchObject({ status: 'unknown', confirmedInserted: null });
    expect(error.message).not.toContain('PRIVATE-SECRET');
  });

  it('accepts a valid failure body exactly at the 16 KiB cap', async () => {
    const encoded = JSON.stringify(failureBody('partial', 2, 'discovery_timeout'));
    const padded = encoded + ' '.repeat(16384 - new TextEncoder().encode(encoded).byteLength);
    rejectWith(new Response(fixtureBody(padded), { status: 504, headers: { 'Content-Type': 'application/json', 'Content-Length': '16384' } }));
    expect(await rejected()).toMatchObject({ status: 'partial', confirmedInserted: 2 });
  });

  it.each([
    null, { inserted: '2', prospects: [] }, { inserted: -1, prospects: [] }, { inserted: 2, prospects: [] },
    { inserted: 26, prospects: Array.from({ length: 26 }, (_, index) => ({ id: `over-limit-${index}` })) },
    { inserted: 1, skipped: -1, prospects: [{ id: 'confirmed' }] },
    { inserted: 1, skipped: '0', prospects: [{ id: 'confirmed' }] },
    { inserted: 1, skipped: 25, prospects: [{ id: 'confirmed' }] },
  ])(
    'does not announce success from an invalid successful-HTTP receipt %#', async data => {
      api.invoke.mockResolvedValueOnce({ data, error: null });
      expect(await rejected()).toMatchObject({ status: 'unknown', confirmedInserted: null });
    },
  );

  it('accepts canonical batches through 25 candidates and preserves the skipped count', async () => {
    for (const [inserted, skipped] of [[24, 1], [25, 0]]) {
      const data = { inserted, skipped,
        prospects: Array.from({ length: inserted }, (_, index) => ({ id: `confirmed-${index}` })),
      };
      api.invoke.mockResolvedValueOnce({ data, error: null });
      await expect(findProspects('Médias spécialisés')).resolves.toEqual(data);
    }
    rejectWith(httpFailure(failureBody('unknown', 25)));
    expect(await rejected()).toMatchObject({ status: 'unknown', confirmedInserted: 25 });
  });

  it('retains the existing successful result and request contract', async () => {
    const data = { inserted: 1, prospects: [{ id: 'confirmed-prospect' }] };
    api.invoke.mockResolvedValueOnce({ data, error: null });
    await expect(findProspects('Sites spécialisés', 'tech', 'website')).resolves.toEqual(data);
    expect(api.invoke).toHaveBeenCalledExactlyOnceWith('partner-find-prospects', {
      body: { query: 'Sites spécialisés', niche: 'tech', type: 'website' },
    });
  });
});

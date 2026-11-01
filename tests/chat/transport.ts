export type Plan = { hold?: boolean; stream?: boolean; text?: string; status?: number; json?: unknown };
export type Call = { key: string; body: Record<string, unknown>; url: string; aborted: boolean };
type Identity = { id: string; email: string } | null;
export const harness = {
  calls: [] as Call[], plans: {} as Record<string, Plan[]>,
  pending: [] as { key: string; respond: (plan: Plan) => void }[],
  setIdentity: (_user: Identity, _loading = false) => {},
};
declare global { interface Window { __chatHarness: typeof harness } }
window.__chatHarness = harness;
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://supabase.example.invalid/')) return originalFetch(input, init);
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
  const method = init?.method ?? 'GET';
  const key = url.includes('/functions/v1/') ? url.split('/').pop()!
    : url.includes('/chat_conversations') ? method === 'POST' ? 'create' : 'history'
      : url.includes('/chat_messages') ? method === 'POST' ? 'write' : 'messages' : 'other';
  const call: Call = { key, body, url, aborted: false }; harness.calls.push(call);
  const signal = init?.signal;
  signal?.addEventListener('abort', () => { call.aborted = true; }, { once: true });
  const defaultPlan = (): Plan => {
    if (key === 'chatbot' || key === 'ai-demo') return { text: 'Réponse vérifiée dans la simulation.' };
    if (key === 'create') return { json: { id: 'conversation-' + harness.calls.length } };
    if (key === 'history') return { json: [{ id: 'history-one', created_at: '2026-11-01T00:00:00Z',
      chat_messages: [{ content: 'Conversation précédente', created_at: '2026-11-01T00:00:00Z' }] }] };
    return { json: [] };
  };
  const makeResponse = (plan: Plan) => {
    if (plan.status && plan.status >= 400) return new Response(JSON.stringify(plan.json ?? { error: 'test failure' }), { status: plan.status });
    if (key !== 'chatbot' && key !== 'ai-demo') return new Response(JSON.stringify(plan.json ?? []), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    const delta = `data: ${JSON.stringify({ choices: [{ delta: { content: plan.text ?? '' } }] })}\n\n`;
    if (!plan.stream) return new Response(delta + 'data: [DONE]\n\n');
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(delta));
      signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
    } }));
  };
  const plan = harness.plans[key]?.shift() ?? defaultPlan();
  // Deliberately allow a held fake response to arrive after abort to exercise stale-response guards.
  if (plan.hold) return new Promise<Response>(resolve => harness.pending.push({ key, respond: p => resolve(makeResponse(p)) }));
  return makeResponse(plan);
};

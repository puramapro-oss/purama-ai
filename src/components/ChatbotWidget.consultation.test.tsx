import { act, type HTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatbotWidget } from './ChatbotWidget';
import { catalogFixture, deferred, operationFixture, OWNER, OTHER_OWNER } from '@/test/consultation-fixtures';
import { SUPER_ADMIN_EMAIL } from '@/lib/constants';

const { auth, invoke, from, legacyFetch } = vi.hoisted(() => ({
  auth: { user: null as { id: string; is_anonymous?: boolean; email?: string; email_confirmed_at?: string } | null,
    session: null as { access_token: string } | null, loading: false },
  invoke: vi.fn(), from: vi.fn(), legacyFetch: vi.fn(),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from } }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('framer-motion', async () => {
  const React = await import('react');
  type Props = HTMLAttributes<HTMLDivElement> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown };
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    motion: { div: React.forwardRef<HTMLDivElement, Props>((props, ref) => {
      const attributes = { ...props };
      delete attributes.initial; delete attributes.animate; delete attributes.exit; delete attributes.transition;
      return React.createElement('div', { ...attributes, ref });
    }), span: ({ initial: _initial, animate: _animate, exit: _exit, transition: _transition, ...props }: Props) => React.createElement('span', props) },
  };
});

let host: HTMLDivElement;
let root: Root;
let scrollTo: PropertyDescriptor | undefined;
async function render() { await act(async () => { root.render(<MemoryRouter><ChatbotWidget /></MemoryRouter>); }); }
function button(name: string) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(element => element.getAttribute('aria-label') === name || element.textContent?.trim() === name);
  if (!found) throw new Error(`Bouton absent : ${name}`);
  return found;
}
async function click(name: string) { await act(async () => { button(name).click(); }); }
async function fill(name: string, value: string) {
  const input = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${name}"]`);
  if (!input) throw new Error(`Champ absent : ${name}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(input instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function recordChatWrites() {
  const writes: Record<string, unknown>[] = [];
  from.mockImplementation((table: string) => ({ insert: (row: Record<string, unknown>) => {
    if (table === 'chat_messages') writes.push(row);
    return {
      select: () => ({ abortSignal: () => ({ single: async () => ({ data: { id: 'retry-conversation' }, error: null }) }) }),
      abortSignal: async () => ({ error: null }),
    };
  } }));
  return writes;
}

type StoredChatMessage = {
  id: string; conversation_id: string; role: string; content: string;
  chat_conversations: { user_id: string };
};
type ChatReadResult = { data: StoredChatMessage | null; error: { code: string; message: string } | null };

// Model the existing primary key and commit separately from receipt of its acknowledgement.
function simulateChatDatabase() {
  const rows = new Map<string, StoredChatMessage>();
  const owners = new Map<string, string>();
  const writes: Record<string, unknown>[] = [];
  const writePlans: ('ok' | 'lost-ack' | 'thrown-lost-ack' | 'not-written' | 'denied')[] = [];
  const transportError = { code: '', message: 'Failed to fetch' };
  const read = vi.fn(async (filters: Record<string, string>, _signal: AbortSignal): Promise<ChatReadResult> => {
    const row = rows.get(filters.id);
    if (!row || row.conversation_id !== filters.conversation_id
      || row.chat_conversations.user_id !== filters['chat_conversations.user_id']
      || row.chat_conversations.user_id !== auth.user?.id) return { data: null, error: null };
    return { data: { ...row, chat_conversations: { ...row.chat_conversations } }, error: null };
  });
  from.mockImplementation((table: string) => {
    if (table === 'chat_conversations') return { insert: (row: { user_id: string }) => ({
      select: () => ({ abortSignal: () => ({ single: async () => {
        const id = crypto.randomUUID(); owners.set(id, row.user_id);
        return { data: { id }, error: null };
      } }) }),
    }) };
    if (table !== 'chat_messages') throw new Error(`Unexpected table: ${table}`);
    return {
      insert: (row: Record<string, unknown>) => ({ abortSignal: async () => {
        writes.push({ ...row });
        const plan = writePlans.shift() ?? 'ok';
        if (plan === 'denied') return { error: { code: '42501', message: 'row-level security policy' }, status: 403 };
        if (plan === 'not-written') return { error: transportError, status: 0 };
        const id = typeof row.id === 'string' ? row.id : crypto.randomUUID();
        if (rows.has(id)) return { error: { code: '23505', message: 'duplicate key' }, status: 409 };
        rows.set(id, { id, conversation_id: String(row.conversation_id), role: String(row.role), content: String(row.content),
          chat_conversations: { user_id: owners.get(String(row.conversation_id))! } });
        if (plan === 'thrown-lost-ack') throw new TypeError('Failed to fetch');
        return { error: plan === 'lost-ack' ? transportError : null, status: plan === 'lost-ack' ? 0 : 201 };
      } }),
      select: () => {
        const filters: Record<string, string> = {};
        let signal: AbortSignal;
        const query = {
          eq: (name: string, value: string) => { filters[name] = value; return query; },
          abortSignal: (value: AbortSignal) => { signal = value; return query; },
          maybeSingle: () => read({ ...filters }, signal),
        };
        return query;
      },
    };
  });
  return { rows, writes, writePlans, read };
}

beforeEach(() => {
  vi.resetAllMocks(); sessionStorage.clear();
  auth.user = { id: OWNER }; auth.session = { access_token: 'first-token' }; auth.loading = false;
  invoke.mockImplementation(async (_name, { body }) => ({ data: body.action === 'catalog' ? { ok: true, catalog: catalogFixture() }
    : { ok: true, operation: operationFixture(body.operationId) }, error: null }));
  from.mockImplementation(() => ({ insert: () => ({
    select: () => ({ abortSignal: () => ({ single: async () => ({ data: { id: 'public-conversation' }, error: null }) }) }),
    abortSignal: async () => ({ error: null }),
  }) }));
  legacyFetch.mockImplementation(async () => new Response('data: {"choices":[{"delta":{"content":"Réponse du chat habituel."}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.supabase.co'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-key');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url.endsWith('/iao-consultation')) {
      const response = await invoke('iao-consultation', { ...init, body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify(response.data), { headers: { 'Content-Type': 'application/json' } });
    }
    return legacyFetch(url, init);
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  scrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => { root.unmount(); }); host.remove(); sessionStorage.clear();
  if (scrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', scrollTo); else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo');
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('ChatbotWidget — connected private consultation mode', () => {
  it.each(['lost-ack', 'thrown-lost-ack'] as const)('reconciles a committed user message after %s before running the model', async failure => {
    const db = simulateChatDatabase(); db.writePlans.push(failure);
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Écriture confirmée par relecture'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(db.read).toHaveBeenCalledTimes(1);
    expect(db.read.mock.calls[0][0]).toEqual({ id: db.writes[0].id, conversation_id: db.writes[0].conversation_id,
      'chat_conversations.user_id': OWNER });
    expect([...db.rows.values()].filter(row => row.role === 'user')).toHaveLength(1);
    expect(db.writes[0].id).toEqual(expect.any(String));
  });

  it('retries an unknown user write with the same identity when the first reconciliation is unavailable', async () => {
    const db = simulateChatDatabase(); db.writePlans.push('lost-ack');
    db.read.mockResolvedValueOnce({ data: null, error: { code: '', message: 'Read unavailable' } });
    const prompt = 'Conserver ce tour malgré la confirmation perdue';
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', prompt); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    expect(legacyFetch).not.toHaveBeenCalled();
    expect([...db.rows.values()].filter(row => row.role === 'user')).toHaveLength(1);
    await click('Envoyer le message');
    expect([...db.rows.values()].filter(row => row.role === 'user')).toHaveLength(1);
    expect(db.writes.filter(row => row.role === 'user').map(row => row.id)).toEqual([db.writes[0].id, db.writes[0].id]);
    expect(db.writes[0].id).toEqual(expect.any(String));
    expect(db.read).toHaveBeenCalledTimes(2);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(legacyFetch.mock.calls[0][1].body).messages).toEqual([{ role: 'user', content: prompt }]);
    expect(host.textContent?.split(prompt)).toHaveLength(2);
  });

  it('retries a genuinely failed write without duplicating its visible turn or model context', async () => {
    const db = simulateChatDatabase(); db.writePlans.push('not-written');
    const prompt = 'Écriture à refaire sans créer un autre tour';
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', prompt); await click('Envoyer le message');
    expect(db.rows.size).toBe(0);
    expect(legacyFetch).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Votre demande est conservée');
    await click('Envoyer le message');
    expect(db.writes.filter(row => row.role === 'user').map(row => row.id)).toEqual([db.writes[0].id, db.writes[0].id]);
    expect([...db.rows.values()].filter(row => row.role === 'user')).toHaveLength(1);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(legacyFetch.mock.calls[0][1].body).messages).toEqual([{ role: 'user', content: prompt }]);
    expect(host.textContent?.split(prompt)).toHaveLength(2);
  });

  it('keeps an explicit RLS write refusal as a refusal without reconciliation or inference', async () => {
    const db = simulateChatDatabase(); db.writePlans.push('denied');
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Ne pas contourner ce refus'); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    expect(db.rows.size).toBe(0);
    expect(db.read).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it.each([
    { label: '401', rejection: { status: 401, message: 'Authentication required' } },
    { label: '403', rejection: { status: 403, message: 'Forbidden' } },
    { label: '42501', rejection: { code: '42501', message: 'row-level security policy' } },
  ])('does not reconcile a definitive thrown $label refusal', async ({ rejection }) => {
    const db = simulateChatDatabase();
    const databaseFrom = from.getMockImplementation()!;
    from.mockImplementation((table: string) => {
      const builder = databaseFrom(table);
      return table === 'chat_messages' ? { ...builder, insert: () => ({ abortSignal: async () => { throw rejection; } }) } : builder;
    });
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Refus explicite du transport'); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    expect(db.read).not.toHaveBeenCalled();
    expect(legacyFetch).not.toHaveBeenCalled();
  });

  it.each(['id', 'conversation_id', 'role', 'content', 'owner'] as const)('rejects a reconciled row with a different %s', async field => {
    const db = simulateChatDatabase(); db.writePlans.push('lost-ack');
    db.read.mockImplementationOnce(async () => {
      const stored = [...db.rows.values()][0];
      const data = { ...stored, chat_conversations: { ...stored.chat_conversations } };
      if (field === 'owner') data.chat_conversations.user_id = OTHER_OWNER;
      else data[field] = field === 'role' ? 'assistant' : 'different-value';
      return { data, error: null };
    });
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Vérifier exactement la ligne'); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    expect(legacyFetch).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(1);
    expect(db.rows.size).toBe(1);
    expect(db.read).toHaveBeenCalledTimes(1);
  });

  it.each(['stop', 'account', 'conversation'] as const)('ignores a late reconciliation after %s', async boundary => {
    const db = simulateChatDatabase(); db.writePlans.push('lost-ack');
    const pending = deferred<ChatReadResult>(); db.read.mockReturnValueOnce(pending.promise);
    const prompt = 'Réconciliation encore en attente';
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', prompt); await click('Envoyer le message');
    expect(db.read).toHaveBeenCalledTimes(1); expect(legacyFetch).not.toHaveBeenCalled();
    const signal = db.read.mock.calls[0][1];
    const oldRow = [...db.rows.values()][0];
    if (boundary === 'stop') await click('Arrêter la réponse');
    else if (boundary === 'conversation') await click('Nouvelle conversation');
    else { auth.user = { id: OTHER_OWNER }; auth.session = { access_token: 'second-token' }; await render(); }
    expect(signal.aborted).toBe(true);
    await act(async () => { pending.resolve({ data: oldRow, error: null }); });
    expect(legacyFetch).not.toHaveBeenCalled();
    if (boundary !== 'stop') expect(host.textContent).not.toContain(prompt);
    await fill('Votre message', prompt); await click('Envoyer le message');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(legacyFetch.mock.calls[0][1].body).messages).toEqual([{ role: 'user', content: prompt }]);
    const userWrites = db.writes.filter(row => row.role === 'user');
    expect(userWrites).toHaveLength(2);
    if (boundary === 'stop') expect(userWrites[1].id).toBe(userWrites[0].id);
    else expect(userWrites[1].id).not.toBe(userWrites[0].id);
    if (boundary === 'account') expect(legacyFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer second-token');
  });

  it('confirms an assistant save with a lost acknowledgement without generating the answer again', async () => {
    const db = simulateChatDatabase(); db.writePlans.push('ok', 'lost-ack');
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Conserver la réponse reçue'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(host.textContent).not.toContain('son enregistrement a échoué');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect([...db.rows.values()].filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(db.read).toHaveBeenCalledTimes(1);
    expect(db.read.mock.calls[0][0]).toEqual({ id: db.writes[1].id, conversation_id: db.writes[1].conversation_id,
      'chat_conversations.user_id': OWNER });
    expect(db.writes[1].id).toEqual(expect.any(String));
  });

  it('keeps an answer visible and reports its unconfirmed save without rerunning inference', async () => {
    const db = simulateChatDatabase(); db.writePlans.push('ok', 'lost-ack');
    db.read.mockResolvedValueOnce({ data: null, error: { code: '', message: 'Read unavailable' } });
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Réponse conservée dans la page'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(host.textContent).toContain('son enregistrement a échoué');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Votre message"]')?.value).toBe('');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    expect(db.writes).toHaveLength(2);
  });

  it('reuses a confirmed user turn when retrying after a model failure', async () => {
    const prompt = 'Reprendre ma demande enregistrée';
    const writes = recordChatWrites();
    legacyFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', prompt); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    expect(host.querySelector<HTMLInputElement>('[aria-label="Votre message"]')?.value).toBe(prompt);
    await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(writes.filter(row => row.role === 'user')).toHaveLength(1);
    expect(writes.filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(from.mock.calls.filter(([table]) => table === 'chat_conversations')).toHaveLength(1);
    expect(legacyFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([{ role: 'user', content: prompt }]);
    expect(host.textContent?.split(prompt)).toHaveLength(2);
  });

  it('keeps an edited request as a distinct turn after failure', async () => {
    const writes = recordChatWrites();
    legacyFetch.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Demande initiale'); await click('Envoyer le message');
    expect(host.textContent).toContain('Limite temporaire');
    await fill('Votre message', 'Demande modifiée'); await click('Envoyer le message');
    expect(writes.filter(row => row.role === 'user').map(row => row.content)).toEqual(['Demande initiale', 'Demande modifiée']);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'Demande initiale' }, { role: 'user', content: 'Demande modifiée' },
    ]);
  });

  it('accepts an intentional identical new turn after a completed answer', async () => {
    const writes = recordChatWrites();
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Même question'); await click('Envoyer le message');
    await fill('Votre message', 'Même question'); await click('Envoyer le message');
    expect(writes.filter(row => row.role === 'user')).toHaveLength(2);
    expect(writes.filter(row => row.role === 'assistant')).toHaveLength(2);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'Même question' }, { role: 'assistant', content: 'Réponse du chat habituel.' },
      { role: 'user', content: 'Même question' },
    ]);
  });

  it('retries a stopped confirmed turn without retaining its partial answer', async () => {
    const writes = recordChatWrites();
    legacyFetch.mockImplementationOnce(async (_url, init: RequestInit) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Fragment provisoire"}}]}\n\n'));
        init.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    })));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Demande interrompue'); await click('Envoyer le message');
    expect(host.textContent).toContain('Fragment provisoire');
    await click('Arrêter la réponse');
    expect(host.textContent).not.toContain('Fragment provisoire');
    await click('Envoyer le message');
    expect(writes.filter(row => row.role === 'user')).toHaveLength(1);
    expect(writes.filter(row => row.role === 'assistant')).toHaveLength(1);
    expect(legacyFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([{ role: 'user', content: 'Demande interrompue' }]);
  });

  it.each(['conversation', 'account'])('does not reuse a failed turn after changing %s', async boundary => {
    const writes = recordChatWrites();
    legacyFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Même texte autre contexte'); await click('Envoyer le message');
    expect(host.textContent).toContain('Votre demande est conservée');
    if (boundary === 'conversation') await click('Nouvelle conversation');
    else { auth.user = { id: OTHER_OWNER }; auth.session = { access_token: 'second-token' }; await render(); }
    await fill('Votre message', 'Même texte autre contexte'); await click('Envoyer le message');
    expect(writes.filter(row => row.role === 'user')).toHaveLength(2);
    expect(from.mock.calls.filter(([table]) => table === 'chat_conversations')).toHaveLength(2);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([{ role: 'user', content: 'Même texte autre contexte' }]);
    if (boundary === 'account') expect(legacyFetch.mock.calls[1][1].headers.Authorization).toBe('Bearer second-token');
  });

  it('retries a guest turn without persistence or duplicate context', async () => {
    auth.user = null; auth.session = null;
    legacyFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Demande visiteur'); await click('Envoyer le message');
    await click('Envoyer le message');
    expect(from).not.toHaveBeenCalled();
    expect(legacyFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([{ role: 'user', content: 'Demande visiteur' }]);
    expect(host.textContent?.split('Demande visiteur')).toHaveLength(2);
  });

  it('mounts the real consultation client without forwarding the existing chat history and restores the chat', async () => {
    await render(); await click("Ouvrir l'assistant PURA");
    await fill('Votre message', 'Ancienne discussion privée'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    await click('Analyse approfondie');
    expect(host.querySelector('[aria-label="Analyse approfondie PURAMA"]')).not.toBeNull();
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('[aria-label="Votre message"]')).toBeNull();
    expect(host.textContent).not.toContain('Ancienne discussion privée');
    await fill('Question de consultation', 'Question indépendante'); await click('Lancer la consultation');
    const request = invoke.mock.calls.find(call => call[1].body.action === 'consult');
    expect(request?.[0]).toBe('iao-consultation');
    expect(request?.[1].headers).toMatchObject({ Authorization: 'Bearer first-token' });
    expect(request?.[1].body).toMatchObject({ action: 'consult', question: 'Question indépendante',
      preferences: { model: 'primary-model', reflection: 'auto', speed: 'standard' },
      reviewerModels: [], research: { queries: [], urls: [] } });
    expect(JSON.stringify(request?.[1].body)).not.toMatch(/Ancienne|chat habituel|messages|userId|budget/);
    expect(host.textContent).toContain('Une réponse utile.');
    expect(host.textContent).not.toMatch(/primary-model|perplexity|Modèle principal|Modèle :/);
    expect(legacyFetch).toHaveBeenCalledTimes(1);
    await click('Conversation');
    expect(host.textContent).toContain('Ancienne discussion privée'); expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(host.textContent).not.toContain('Une réponse utile.');
    await fill('Votre message', 'Suite de la conversation'); await click('Envoyer le message');
    expect(JSON.parse(legacyFetch.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'Ancienne discussion privée' }, { role: 'assistant', content: 'Réponse du chat habituel.' },
      { role: 'user', content: 'Suite de la conversation' },
    ]);
    expect(invoke.mock.calls.filter(call => call[1].body.action === 'consult')).toHaveLength(1);
  });

  it('shows technical controls only for the verified founder and removes them on loss of verification', async () => {
    auth.user = { id: OWNER, email: SUPER_ADMIN_EMAIL };
    await render(); await click("Ouvrir l'assistant PURA"); await click('Analyse approfondie');
    expect(host.querySelector('[aria-label="Modèle principal"]')).toBeNull();
    auth.user = { id: OWNER, email: SUPER_ADMIN_EMAIL, email_confirmed_at: '2026-11-13T10:00:00Z' };
    await render();
    expect(host.textContent).toContain('Réglages techniques du fondateur');
    expect(host.querySelector('[aria-label="Modèle principal"]')).not.toBeNull();
    await fill('Question de consultation', 'Brouillon du fondateur');
    auth.user = { id: OWNER, email: SUPER_ADMIN_EMAIL };
    await render();
    expect(host.querySelector('[aria-label="Modèle principal"]')).toBeNull();
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Question de consultation"]')?.value).toBe('');
    expect(host.textContent).not.toContain('primary-model');
    expect(invoke.mock.calls.filter(call => call[1].body.action === 'consult')).toHaveLength(0);
  });

  it('keeps public chat usable without exposing private consultation to visitors or anonymous sessions', async () => {
    auth.user = null; auth.session = null;
    await render(); await click("Ouvrir l'assistant PURA");
    expect(host.querySelector('[aria-label="Mode de conversation"]')).toBeNull();
    await fill('Votre message', 'Question du visiteur'); await click('Envoyer le message');
    expect(host.textContent).toContain('Réponse du chat habituel.');
    expect(legacyFetch).toHaveBeenCalledTimes(1); expect(from).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    auth.user = { id: OWNER, is_anonymous: true }; auth.session = { access_token: 'anonymous-token' };
    await render();
    expect(host.querySelector('[aria-label="Mode de conversation"]')).toBeNull(); expect(invoke).not.toHaveBeenCalled();
  });

  it('aborts and clears the old private panel when the account changes, keeping old results out of the new account', async () => {
    const pending = deferred<unknown>();
    invoke.mockImplementation(async (_name, { body }) => body.action === 'consult' ? pending.promise : { data: { ok: true, catalog: catalogFixture() }, error: null });
    auth.user = { id: OWNER, email: SUPER_ADMIN_EMAIL, email_confirmed_at: '2026-11-13T10:00:00Z' };
    await render(); await click("Ouvrir l'assistant PURA"); await click('Analyse approfondie');
    expect(host.querySelector('[aria-label="Modèle principal"]')).not.toBeNull();
    await fill('Question de consultation', 'Secret du premier compte'); await click('Lancer la consultation');
    const request = invoke.mock.calls.find(call => call[1].body.action === 'consult')![1];
    auth.user = { id: OTHER_OWNER }; auth.session = { access_token: 'second-token' };
    await render();
    expect(request.signal.aborted).toBe(true);
    expect(host.textContent).not.toContain('Secret du premier compte');
    expect(host.querySelector('[aria-label="Analyse approfondie PURAMA"]')).toBeNull();
    await act(async () => { pending.resolve({ data: { ok: true, operation: operationFixture(request.body.operationId) }, error: null }); });
    await click('Analyse approfondie');
    expect(host.querySelector('[aria-label="Modèle principal"]')).toBeNull();
    expect(host.textContent).not.toContain('Une réponse utile.');
    expect(host.textContent).not.toContain('Actualiser l’état');
    expect(invoke.mock.calls.at(-1)?.[1].headers).toMatchObject({ Authorization: 'Bearer second-token' });
    expect(invoke.mock.calls.filter(call => call[1].body.action === 'consult')).toHaveLength(1);
  });
});

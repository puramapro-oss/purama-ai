export const OWNER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
type Session = { user: { id: string }; access_token: string } | null;
export const port = {
  auth: [] as Array<{ done: boolean; resolve: (value: { data: { session: Session }; error: null }) => void; reject: (reason: Error) => void }>,
  fetches: [] as Array<{ url: string; init: RequestInit; done: boolean; resolve: (response: Response) => void; reject: (reason: Error) => void }>,
  calls: [] as Array<{ name: string; value?: unknown }>,
  session(owner = OWNER): Session { return { user: { id: owner }, access_token: owner === OWNER ? 'fixture-owner' : 'fixture-other' }; },
  resolveAuth(index: number, owner: string | null = OWNER) {
    const pending = port.auth[index]; if (!pending || pending.done) throw new Error('Missing auth request');
    pending.done = true; pending.resolve({ data: { session: owner ? port.session(owner) : null }, error: null });
  },
  resolveFetch(index: number, body: unknown, status = 200) {
    const pending = port.fetches[index]; if (!pending || pending.done) throw new Error('Missing fetch request');
    pending.done = true; pending.resolve(Response.json(body, { status }));
  },
  rejectFetch(index: number) {
    const pending = port.fetches[index]; if (!pending || pending.done) throw new Error('Missing fetch request');
    pending.done = true; pending.reject(new Error('Synthetic network failure'));
  },
};
export const supabase = {
  auth: { getSession: () => new Promise<{ data: { session: Session }; error: null }>((resolve, reject) => port.auth.push({ done: false, resolve, reject })) },
  from(name: string) {
    port.calls.push({ name: 'from', value: name });
    const query = {
      select(fields?: string) { port.calls.push({ name: 'select', value: fields }); return query; },
      eq() { return query; }, delete() { return query; }, abortSignal() { return query; },
      then(resolve: (value: { data: unknown[]; error: null }) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve); },
    };
    return query;
  },
};
// Ignore cancellation deliberately: admission after asynchronous handoff must
// hold even for a non-cooperative transport. The real HTTP port stays blocked.
window.fetch = (input, init) => new Promise<Response>((resolve, reject) => port.fetches.push({
  url: String(input), init: init ?? {}, done: false, resolve, reject,
}));
Object.assign(window, { oauthPort: port });

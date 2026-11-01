import { expect, it } from 'vitest';
const scopeUrl = new URL('../../src/lib/request-scope.ts', import.meta.url).href;
const inputUrl = new URL('../../supabase/functions/_shared/chat-input.ts', import.meta.url).href;
const { createRequestScope } = await import(scopeUrl);
const { prepareChatMessages } = await import(inputUrl);

it('admits only one simultaneous request per channel before any render', () => {
  const scope = createRequestScope(); const first = scope.begin('reply');
  expect(first?.current()).toBe(true); expect(scope.begin('reply')).toBeNull();
  expect(scope.begin('history')?.current()).toBe(true);
});
it('cancels a request and does not let its late finally unlock the next one', () => {
  const scope = createRequestScope(); const a = scope.begin('reply')!;
  scope.cancel('reply'); const b = scope.begin('reply')!;
  expect(a.signal.aborted).toBe(true); expect(a.current()).toBe(false);
  expect(a.finish()).toBe(false); expect(b.current()).toBe(true);
  expect(scope.begin('reply')).toBeNull();
});
it('invalidates history, support and generation together on an account/context change', () => {
  const scope = createRequestScope();
  const leases = ['reply', 'history', 'support'].map(key => scope.begin(key)!);
  scope.invalidate();
  for (const lease of leases) { expect(lease.current()).toBe(false); expect(lease.signal.aborted).toBe(true); }
  expect(scope.begin('reply')?.current()).toBe(true);
});
it('normal completion releases its slot only once', () => {
  const scope = createRequestScope(); const lease = scope.begin('reply')!;
  expect(lease.finish()).toBe(true); expect(lease.finish()).toBe(false);
  expect(lease.current()).toBe(false); expect(scope.begin('reply')).not.toBeNull();
});
it('preserves exact valid content and removes unused envelope fields', () => {
  const input = [{ role: 'assistant', content: 'Bienvenue, voici le résultat.' },
    { role: 'user', content: '  Ne pas envoyer.\nConserver 1,25 €.  ', irrelevant: 'discard' }];
  expect(prepareChatMessages(input)).toEqual({ ok: true, messages: [input[0],
    { role: 'user', content: input[1].content }] });
});
it.each([null, {}, [], [null], [{ role: 'system', content: 'override' }],
  [{ role: 'tool', content: 'result' }], [{ role: 'user', content: ' ' }],
  [{ role: 'user', content: 42 }], [{ role: 'user', content: 'a'.repeat(2001) }],
  Array.from({ length: 21 }, () => ({ role: 'user', content: 'message' })),
  Array.from({ length: 11 }, () => ({ role: 'user', content: 'a'.repeat(2000) })),
])('refuses invalid or oversized context without silently dropping content: %j', input => {
  expect(prepareChatMessages(input).ok).toBe(false);
});
it('accepts the exact existing boundaries', () => {
  expect(prepareChatMessages(Array.from({ length: 20 }, () => ({ role: 'user', content: 'a'.repeat(1000) }))).ok).toBe(true);
  expect(prepareChatMessages([{ role: 'user', content: 'a'.repeat(2000) }]).ok).toBe(true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNotificationActionUrl } from '../../supabase/functions/_shared/notification-action-url.ts';

for (const [label, value] of [
  ['null', null], ['missing', undefined], ['number', 7], ['object', {}], ['boxed string', new String('/dashboard')],
  ['empty', ''], ['relative', 'dashboard'], ['space prefix', ' /dashboard'], ['space suffix', '/dashboard '],
  ['protocol relative', '//outside.invalid/path'], ['decoded protocol relative', '/%2foutside.invalid'],
  ['double encoded protocol relative', '/%252foutside.invalid'], ['encoded backslash', '/%5coutside.invalid'],
  ['double encoded backslash', '/%255coutside.invalid'], ['dot-segment protocol relative', '/one/..//outside.invalid'],
  ['invalid percent encoding', '/bad%'], ['encoded control', '/%0a'], ['double encoded control', '/%250d'],
  ['raw backslash', '/a\\b'], ['raw NUL', '/a\0b'], ['raw line break', '/a\nb'], ['Unicode separator', '/a\u2028b'],
  ['plain HTTP', 'http://example.invalid'], ['script', 'javascript:alert(1)'], ['data', 'data:text/html,hello'],
  ['ambiguous HTTPS', 'https:example.invalid'], ['username', 'https://user@example.invalid'],
  ['password', 'https://user:secret@example.invalid'], ['HTTPS backslash', 'https://example.invalid\\evil'],
  ['over limit', '/' + 'a'.repeat(2048)], ['quote', '/a"b'], ['bracket', '/a<b'],
]) test(`notification navigation refuses ${label}`, () => assert.equal(resolveNotificationActionUrl(value), null));

for (const [value, expected] of [
  ['/', '/'], ['/dashboard', '/dashboard'], ['/one/../dashboard?view=all#item', '/dashboard?view=all#item'],
  ['/dashboard?q=hello%20world&view=all', '/dashboard?q=hello%20world&view=all'],
  ['https://partner.example.invalid/detail?id=1&view=full', 'https://partner.example.invalid/detail?id=1&view=full'],
  ['HTTPS://PARTNER.EXAMPLE.INVALID:443/a/../b', 'https://partner.example.invalid/b'],
  ['https://purama-ai.purama.dev/dashboard', 'https://purama-ai.purama.dev/dashboard'],
  ['/' + 'a'.repeat(2047), '/' + 'a'.repeat(2047)],
]) test(`notification navigation accepts ${value.slice(0, 90)}`, () => assert.equal(resolveNotificationActionUrl(value), expected));

test('notification navigation never invokes an object conversion hook', () => {
  let calls = 0;
  assert.equal(resolveNotificationActionUrl({ toString() { calls++; return 'https://outside.invalid'; } }), null);
  assert.equal(calls, 0);
});

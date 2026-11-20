import { describe, expect, it } from 'vitest';
import { authPagePath, resolveAuthContinuation, safeAuthContinuation } from './auth-continuation';

const TEMPLATE = '/modeles/230dc59b-3fae-436f-8365-e7d24998281d';

describe('auth continuation boundary', () => {
  it.each([
    ['/dashboard/creator-agent/new', '/dashboard/creator-agent/new'],
    [TEMPLATE, TEMPLATE],
    ['/ambassadeur/rejoindre', '/ambassadeur/rejoindre'],
    ['/dashboard?tab=billing#usage', '/dashboard?tab=billing#usage'],
    ['/dashboard?view=grid&page=2#overview', '/dashboard?view=grid&page=2#overview'],
    [`${TEMPLATE}?utm_campaign=test#details`, `${TEMPLATE}#details`],
  ])('keeps an internal navigation destination %s', (input, expected) => {
    expect(safeAuthContinuation(input)).toBe(expected);
  });

  it.each([
    'https://attacker.example', 'http://attacker.example', '//attacker.example',
    '/\\attacker.example', '/%5cattacker.example', '/%255cattacker.example',
    '/%2f%2fattacker.example', '/%252f%252fattacker.example',
    'javascript:alert(1)', 'data:text/html,anything', 'dashboard',
    ' /dashboard', '/dashboard ', '/dash\nboard', '/%0adashboard', '/invalid%',
    '/dashboard%3Faccess_token%3Dprivate', '/dashboard%2523access_token%253Dprivate',
    null, undefined, 42, { pathname: '/dashboard' }, `/${'x'.repeat(2048)}`,
  ])('rejects non-local or malformed navigation %j', (input) => {
    expect(safeAuthContinuation(input)).toBeNull();
  });

  it.each([
    '/login', '/LOGIN/', '/signup?next=/dashboard', '/%6cogin', '/%256cogin',
    '/before/../login', '/%252e%252e/login', '/forgot-password', '/reset-password',
    '/auth/callback', '/oauth/callback?code=private', '/logout', '/signout',
    '/go/untrusted-destination', '/api/do-something',
  ])('does not return into an auth or redirect handler %s', (input) => {
    expect(safeAuthContinuation(input)).toBeNull();
  });

  it('discards tokens, personal data and provider/payment success flags', () => {
    expect(safeAuthContinuation('/dashboard?tab=billing&access_token=private&refresh_token=private'
      + '&id_token=private&code=private&password=private&email=person%40example.test'
      + '&success=true&overage_success=true&gmail=connected&connected=true#access_token=private'))
      .toBe('/dashboard?tab=billing');
  });

  it('does not forward a nested next or ambiguous presentation parameters', () => {
    expect(safeAuthContinuation('/pricing?next=%2Flogin&tab=billing&tab=other&page=2&success=true'))
      .toBe('/pricing?page=2');
  });

  it.each([
    '/dashboard?tab=contains%20spaces', '/dashboard?view=https%3A%2F%2Fexample.test',
    '/dashboard?page=0', '/dashboard?page=-1', '/dashboard?page=1.5',
    '/dashboard?page=2&page=3', '/dashboard?page=1000000',
    '/dashboard#access-token', '/dashboard#refresh_token=secret',
    '/dashboard#state=secret', '/dashboard#too%20many%20words',
  ])('minimizes unsupported selectors and fragments in %s', (input) => {
    expect(safeAuthContinuation(input)).toBe('/dashboard');
  });

  it('prefers a valid next over the previous protected route', () => {
    expect(resolveAuthContinuation(`?next=${encodeURIComponent(TEMPLATE)}`, { pathname: '/pricing' }))
      .toBe(TEMPLATE);
  });

  it.each([
    '?next=%2Fdashboard%2Fagents&next=%2Fpricing',
    '?next=%2Fdashboard%2Fagents&%6eext=%2Fpricing',
    '?next=%2Fdashboard%2Fagents&NeXt=%2Fpricing',
    '?next=https%3A%2F%2Fattacker.example', '?next=%2Fsignup', '?next=',
  ])('falls back safely for an invalid or ambiguous next: %s', (search) => {
    expect(resolveAuthContinuation(search, { pathname: '/pricing' })).toBe('/pricing');
    expect(resolveAuthContinuation(search)).toBe('/dashboard');
  });

  it('preserves a protected-route location with minimized query and hash', () => {
    expect(resolveAuthContinuation('', {
      pathname: '/dashboard', search: '?tab=billing&token=private', hash: '#usage',
    })).toBe('/dashboard?tab=billing#usage');
  });

  it('also supports a legacy string state.from', () => {
    expect(resolveAuthContinuation('', '/notifications')).toBe('/notifications');
  });

  it.each([
    null, {}, { pathname: '//attacker.example' }, { pathname: '/login' },
    { pathname: '/dashboard', search: 'not-a-search' },
    { pathname: '/dashboard', hash: 'not-a-fragment' },
    { pathname: '/dashboard', search: 12 }, { pathname: '/dashboard', hash: {} },
  ])('does not trust malformed location state %j', (from) => {
    expect(resolveAuthContinuation('', from)).toBe('/dashboard');
  });

  it('bounds query parsing and still preserves a legitimate state fallback', () => {
    expect(resolveAuthContinuation(`?noise=${'x'.repeat(8192)}&next=%2Fpricing`, '/notifications'))
      .toBe('/notifications');
  });

  it('carries the same safe route when switching between login and signup', () => {
    const href = authPagePath('/signup', `${TEMPLATE}?token=secret#details`);
    const url = new URL(href, 'https://app.example');
    expect(url.pathname).toBe('/signup');
    expect(url.searchParams.getAll('next')).toEqual([`${TEMPLATE}#details`]);
    expect(resolveAuthContinuation(url.search)).toBe(`${TEMPLATE}#details`);
    expect(href).not.toContain('secret');
  });

  it('never turns an auth link builder into an external redirect', () => {
    expect(authPagePath('/login', '//attacker.example')).toBe('/login?next=%2Fdashboard');
  });

  it('preserves one explicitly supplied valid referral across login/signup', () => {
    const next = `${TEMPLATE}?ref=PARTNER_42-a&success=true&token=secret`;
    expect(safeAuthContinuation(next)).toBe(`${TEMPLATE}?ref=PARTNER_42-a`);
    const signup = new URL(authPagePath('/signup', next), 'https://app.example');
    expect(resolveAuthContinuation(signup.search)).toBe(`${TEMPLATE}?ref=PARTNER_42-a`);
  });

  it.each(['ref=', 'ref=wrong%20code', 'ref=one&ref=two', `ref=${'a'.repeat(65)}`])(
    'does not forward an invalid or ambiguous referral: %s', (search) => {
      expect(safeAuthContinuation(`${TEMPLATE}?${search}`)).toBe(TEMPLATE);
    },
  );
});

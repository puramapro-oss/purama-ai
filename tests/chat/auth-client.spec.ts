import { test, expect, type Page } from './fixtures';
import type { Route } from '@playwright/test';
import type {} from './sdk-init';

const storageKey = 'sb-supabase-auth-token';
const owner = '00000000-0000-4000-8000-000000000061';
const authOrigin = 'https://supabase.example.invalid';
type AuthCall = { method: string; path: string; grant: string | null; scope: string | null; fixtureAuthorization: boolean; fixtureRefreshToken?: boolean };

function sessionFixture(suffix = 'original') {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: owner, aud: 'authenticated', role: 'authenticated', exp: expiresAt, fixture: suffix })}.c3ludGhldGlj`;
  return { access_token: accessToken, refresh_token: 'synthetic-refresh-' + suffix, token_type: 'bearer', expires_in: 3600,
    expires_at: expiresAt, user: { id: owner, aud: 'authenticated', role: 'authenticated', email: 'sdk-fixture@example.invalid',
      app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: '2026-11-24T00:00:00Z' } };
}

let pageErrors: string[];
let calls: AuthCall[];
let unexpectedAuth: AuthCall[];
let session: ReturnType<typeof sessionFixture>;
let holdRefresh: boolean;
let pendingRefresh: Route | null;

async function open(page: Page, persisted = false) {
  if (persisted) await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), { key: storageKey, value: session });
  await page.goto('/tests/chat/sdk-init.html');
  await expect(page.getByTestId('sdk-status')).toHaveText('ready');
  await expect.poll(() => page.evaluate(() => window.__sdkAuthProbe.state.events.some(event => event.event === 'INITIAL_SESSION'))).toBe(true);
  await page.evaluate(() => window.__sdkAuthProbe.afterPendingTasks());
}

test.beforeEach(async ({ page }) => {
  pageErrors = []; calls = []; unexpectedAuth = []; holdRefresh = false; pendingRefresh = null;
  session = sessionFixture();
  // Registered before navigation: module-initialisation errors are part of the test.
  page.on('pageerror', error => pageErrors.push(error.message));
  // Every auth request is fulfilled here or aborted. The context fixture still blocks all other remote traffic.
  await page.route(authOrigin + '/auth/v1/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const call: AuthCall = { method: request.method(), path: url.pathname, grant: url.searchParams.get('grant_type'), scope: url.searchParams.get('scope'),
      fixtureAuthorization: request.headers().authorization === 'Bearer ' + session.access_token };
    calls.push(call);
    if (call.method === 'GET' && call.path === '/auth/v1/user') return route.fulfill({ status: 200, json: session.user });
    if (call.method === 'POST' && call.path === '/auth/v1/logout') return route.fulfill({ status: 204 });
    if (call.method === 'POST' && call.path === '/auth/v1/token' && call.grant === 'refresh_token') {
      call.fixtureRefreshToken = request.postDataJSON()?.refresh_token === session.refresh_token;
      if (holdRefresh) { pendingRefresh = route; return; }
      return route.fulfill({ status: 200, json: sessionFixture('rotated') });
    }
    unexpectedAuth.push(call);
    await route.abort('blockedbyclient');
  });
});

test.afterEach(async ({ page, browser }, testInfo) => {
  if (pendingRefresh) { await pendingRefresh.abort(); pendingRefresh = null; }
  await page.evaluate(() => window.__sdkAuthProbe?.afterPendingTasks());
  const probe = await page.evaluate(() => window.__sdkAuthProbe?.state ?? null);
  await testInfo.attach('auth-sdk-runtime', { body: Buffer.from(JSON.stringify({
    platform: process.platform, browser: browser.browserType().name(), version: browser.version(), viewport: page.viewportSize(),
    authTransport: 'synthetic responses only; no real account or auth server', externalAuthRequestsForwarded: 0,
    simulatedVisibility: (probe?.visibility.length ?? 0) > 0, pageErrors, calls, unexpectedAuth, probe,
  }, null, 2)), contentType: 'application/json' });
  expect(unexpectedAuth, 'Unexpected auth endpoints are aborted rather than forwarded').toEqual([]);
  expect(pageErrors, 'Real SDK initialization and its asynchronous work must not emit page errors').toEqual([]);
});

test('real auth client initializes without a session, supports concurrent reads and a simulated visibility return without page errors', async ({ page }) => {
  await open(page);
  const empty = Array.from({ length: 3 }, () => ({ userId: null, error: null }));
  expect(await page.evaluate(() => window.__sdkAuthProbe.readConcurrently())).toEqual(empty);
  expect(await page.evaluate(() => window.__sdkAuthProbe.simulateVisibilityReturn())).toEqual(empty);
  expect(await page.evaluate(() => window.__sdkAuthProbe.state.visibility)).toEqual(['hidden', 'visible']);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect(calls).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('real auth client recovers a persisted session and clears it on sign-out without a stale identity', async ({ page }) => {
  await open(page, true);
  const expected = Array.from({ length: 3 }, () => ({ userId: owner, error: null }));
  expect(await page.evaluate(() => window.__sdkAuthProbe.readConcurrently())).toEqual(expected);
  expect(await page.evaluate(() => window.__sdkAuthProbe.simulateVisibilityReturn())).toEqual(expected);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).user.id, storageKey)).toBe(owner);
  expect(await page.evaluate(() => window.__sdkAuthProbe.signOut())).toEqual({ error: null });
  expect(calls.filter(call => call.path === '/auth/v1/logout')).toEqual([
    { method: 'POST', path: '/auth/v1/logout', grant: null, scope: 'global', fixtureAuthorization: true },
  ]);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect(await page.evaluate(() => window.__sdkAuthProbe.readConcurrently())).toEqual(Array.from({ length: 3 }, () => ({ userId: null, error: null })));
  expect(await page.evaluate(() => window.__sdkAuthProbe.state.events.at(-1))).toEqual({ event: 'SIGNED_OUT', userId: null });
});

test('real auth client does not restore a signed-out session when an older refresh completes late', async ({ page }) => {
  holdRefresh = true;
  await open(page, true);
  await page.evaluate(() => window.__sdkAuthProbe.startRefresh());
  await expect.poll(() => pendingRefresh !== null).toBe(true);
  expect(calls.filter(call => call.path === '/auth/v1/token')).toMatchObject([{ method: 'POST', grant: 'refresh_token', fixtureRefreshToken: true }]);
  expect(await page.evaluate(() => window.__sdkAuthProbe.signOut())).toEqual({ error: null });
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  const held = pendingRefresh!;
  pendingRefresh = null;
  await held.fulfill({ status: 200, json: sessionFixture('late-rotation') });
  await expect.poll(() => page.evaluate(() => window.__sdkAuthProbe.state.refresh)).toEqual({ state: 'settled', userId: null, error: 'AuthRefreshDiscardedError' });
  expect(await page.evaluate(() => window.__sdkAuthProbe.readConcurrently())).toEqual(Array.from({ length: 3 }, () => ({ userId: null, error: null })));
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  const events = await page.evaluate(() => window.__sdkAuthProbe.state.events);
  const signedOutIndex = events.findIndex(event => event.event === 'SIGNED_OUT');
  expect(signedOutIndex).toBeGreaterThanOrEqual(0);
  expect(events.slice(signedOutIndex + 1).filter(event => event.userId !== null)).toEqual([]);
});

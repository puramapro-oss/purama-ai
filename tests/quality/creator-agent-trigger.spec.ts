import { test, expect, type Route } from '@playwright/test';
import { qualityOrigin } from './quality-environment';

// Real product page, hook, Supabase browser SDK and native Web Locks, in two
// same-origin Chromium pages. All Auth/data/Edge responses are synthetic routes;
// nothing reaches a real Supabase, KARTA, Redis, model or business provider.
const ownerId = '81000000-0000-4000-8000-000000000001';
const agentId = '82000000-0000-4000-8000-000000000001';
const storageKey = `purama:karta-custom-trigger:v1:${ownerId}:${agentId}`;
const user = { id: ownerId, email: 'trigger-fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const agent = { id: agentId, user_id: ownerId, name: 'Agent de réception', slug: 'agent-reception',
  description: 'Agent synthétique pour qualifier la livraison.', emoji: '📋', color: 'cyan', category: 'productivity',
  system_prompt: 'Consigne synthétique.', model: 'claude-sonnet-4-6', temperature: 0.5, max_tokens: 1000,
  tools_enabled: [], schedule_enabled: false, schedule_cron: null, schedule_input: null,
  last_scheduled_run: null, karta_enabled: true, is_active: true, is_public: false, is_template: false,
  total_runs: 0, total_tokens: 0, avg_rating: null, cloned_from: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(value) });
}

test('native same-origin locks prevent a second tab admission and preserve the lost-ack intention', async ({ context, page }, testInfo) => {
  const bodies: Array<{ agentId: string; requestId: string }> = [];
  const errors: string[] = [];
  let releaseLostAck!: () => void;
  const heldResponse = new Promise<void>(resolve => { releaseLostAck = resolve; });
  await context.routeWebSocket('**/*', async socket => { await socket.close(); });
  await context.addInitScript(({ user }) => {
    localStorage.setItem('purama_ai_intro_seen', '1');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    if (!localStorage.getItem('sb-supabase-auth-token')) {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user.id, exp: expiresAt, role: 'authenticated' }))}.local-fixture`;
      localStorage.setItem('sb-supabase-auth-token', JSON.stringify({ access_token: token,
        refresh_token: 'local-fixture', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user }));
    }
    // No navigator.locks replacement: both pages use the browser's lock manager.
  }, { user });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === qualityOrigin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/profiles')) return json(route, { user_id: ownerId, full_name: 'Réception' });
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/creator_agents')) return json(route, agent);
    if (url.pathname.endsWith('/karta_agent_state')) return json(route, {
      id: '83000000-0000-4000-8000-000000000001', user_id: ownerId, agent_type: `custom:${agentId}`,
      is_enabled: true, autonomy_level: 1, kill_switch: false, simulation_mode: true, last_run_at: null, last_run_status: null,
    });
    if (url.pathname.endsWith('/functions/v1/karta-trigger-custom')) {
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as { agentId: string; requestId: string };
      expect(Object.keys(body).sort()).toEqual(['agentId', 'requestId']);
      expect(body.agentId).toBe(agentId);
      expect(body.requestId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      bodies.push(body);
      if (bodies.length === 1) {
        await heldResponse;
        return route.abort('failed'); // Synthetic admission acknowledgement is lost.
      }
      const jobId = `karta-v2-dedupe-${'a'.repeat(64)}`;
      return json(route, { ok: true, queued: true, requestId: body.requestId, jobId, executionKey: `queue:v2:${jobId}` }, 202);
    }
    return json(route, []);
  });

  const second = await context.newPage();
  for (const current of [page, second]) {
    current.on('pageerror', error => { errors.push(error.message); });
    await current.goto(`/dashboard/creator-agent/${agentId}`);
    await expect(current.getByRole('heading', { name: agent.name, exact: true })).toBeVisible();
    await current.getByRole('tab', { name: 'Paramètres', exact: true }).click();
    await expect(current.getByRole('button', { name: 'Tester maintenant', exact: true })).toBeEnabled();
    expect(await current.evaluate(() => typeof navigator.locks?.request === 'function')).toBe(true);
  }
  expect(await page.evaluate(() => location.origin)).toBe(await second.evaluate(() => location.origin));

  await page.getByRole('button', { name: 'Tester maintenant', exact: true }).click();
  await expect.poll(() => bodies.length).toBe(1);
  const firstId = bodies[0].requestId;
  await expect.poll(() => page.evaluate(async key => (await navigator.locks.query()).held?.some(lock => lock.name === key), storageKey)).toBe(true);
  await second.getByRole('button', { name: 'Tester maintenant', exact: true }).click();
  await expect(second.getByText('Un déclenchement est déjà en cours de vérification.', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(await second.evaluate(key => localStorage.getItem(key), storageKey)).toBe(firstId);
  await second.screenshot({ path: testInfo.outputPath('native-second-tab-refused.png'), fullPage: true });

  releaseLostAck();
  await expect(page.getByText(/Le déclenchement n’est pas confirmé/)).toBeVisible();
  await expect.poll(() => page.evaluate(async key => (await navigator.locks.query()).held?.some(lock => lock.name === key), storageKey)).toBe(false);
  await second.getByRole('button', { name: 'Tester maintenant', exact: true }).click();
  await expect(second.getByText('Agent déclenché', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1].requestId).toBe(firstId);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();

  await page.getByRole('button', { name: 'Tester maintenant', exact: true }).click();
  await expect(page.getByText('Agent déclenché', { exact: true })).toBeVisible();
  expect(bodies).toHaveLength(3);
  expect(bodies[2].requestId).not.toBe(firstId);
  expect(errors).toEqual([]);
});

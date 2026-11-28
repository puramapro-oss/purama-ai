import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

// The row below is produced by the real qualifier, projector, SQL migration and
// shared reader in the reception script. Only browser transport is synthetic.
// Run that script first; no database or model service is contacted by this test.
const receipt = JSON.parse(readFileSync(new URL('../../qa/resolution-qualification-20261125/private-resolution-roundtrip.json', import.meta.url), 'utf8'));
const fixture = receipt.browserFixture;
const reply = 'Réponse de transport synthétique : les informations du dossier restent à vérifier.';
const agentName = 'Dossier de réception';

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify(value) });
}

async function prepare(page: Page) {
  expect(receipt.status).toBe('PASS');
  for (const path of ['karta/src/knowledge/private-result-view.ts', 'karta/src/engine/private-tool-results.ts',
    'supabase/functions/_shared/private-tool-results.ts']) {
    const currentHash = createHash('sha256').update(readFileSync(new URL(`../../${path}`, import.meta.url))).digest('hex');
    expect(currentHash, `The reception row must match the current ${path}`).toBe(receipt.sourceSha256[path]);
  }
  const user = { id: fixture.ownerId, email: 'resolution-fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
    app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
  const agent = { id: fixture.agentId, user_id: fixture.ownerId, name: agentName, slug: 'dossier-reception',
    description: 'Parcours de réception synthétique.', emoji: '📋', color: 'cyan', category: 'productivity',
    system_prompt: 'Consigne synthétique.', model: 'claude-sonnet-4-6', temperature: 0.5, max_tokens: 1000,
    tools_enabled: ['qualify_resolution'], schedule_enabled: false, schedule_cron: null, schedule_input: null,
    last_scheduled_run: null, karta_enabled: true, is_active: true, is_public: false, is_template: false,
    total_runs: 1, total_tokens: 0, avg_rating: null, cloned_from: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const state = { privateReads: 0, deletions: 0, chatBodies: [] as Record<string, unknown>[] };
  await page.context().routeWebSocket('**/*', async socket => { await socket.close(); });
  await page.addInitScript(({ user }) => {
    localStorage.setItem('purama_ai_intro_seen', '1');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user.id, exp: expiresAt, role: 'authenticated' }))}.local-fixture`;
    localStorage.setItem('sb-supabase-auth-token', JSON.stringify({ access_token: token,
      refresh_token: 'local-fixture', token_type: 'bearer', expires_in: 3600, expires_at: expiresAt, user }));
  }, { user });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    const method = route.request().method();
    if (method === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/profiles')) return json(route, { user_id: user.id, full_name: 'Réception' });
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/creator_agents')) return json(route, agent);
    if (url.pathname.endsWith('/karta_tool_results')) {
      expect(url.searchParams.get('user_id')).toBe(`eq.${fixture.ownerId}`);
      expect(url.searchParams.get('creator_agent_id')).toBe(`eq.${fixture.agentId}`);
      if (method === 'DELETE') {
        expect(url.searchParams.get('id')).toBe(`eq.${fixture.storedRow.id}`);
        state.deletions++;
        return json(route, [{ id: fixture.storedRow.id }]);
      }
      expect(method).toBe('GET');
      expect(url.searchParams.get('limit')).toBe('20');
      state.privateReads++;
      return json(route, state.deletions ? [] : [fixture.storedRow]);
    }
    if (url.pathname.endsWith('/creator-agent-chat')) {
      expect(method).toBe('POST');
      state.chatBodies.push(route.request().postDataJSON());
      return json(route, { reply, tokens: 0 });
    }
    return json(route, []);
  });
  return state;
}

for (const viewport of [{ label: 'desktop', width: 1440, height: 1000 }, { label: 'mobile', width: 390, height: 844 }]) {
  test(`private resolution read, explicit chat selection and confirmed deletion on ${viewport.label}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const state = await prepare(page);
    const pageErrors: string[] = [];
    page.on('pageerror', error => { pageErrors.push(error.message); });
    await page.goto(`/dashboard/creator-agent/${fixture.agentId}`);
    await expect(page.getByRole('heading', { name: agentName, exact: true })).toBeVisible();
    await page.getByRole('tab', { name: /^Runs/ }).click();
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Analyse de dossier', exact: true }) });
    await expect(card.getByText('Analyse disponible', { exact: true })).toBeVisible();
    await expect(card.getByText('Complet', { exact: true })).toHaveCount(0);
    const resolution = fixture.parsedResult.payload.resolution;
    await expect(card.locator('dl').first().getByText(resolution.snapshot.caseId, { exact: true })).toBeVisible();
    await expect(card.locator(`time[datetime="${resolution.snapshot.asOf}"]`)).toBeVisible();
    await expect(card.getByText(/Enregistrée le/)).toBeVisible();
    for (const section of resolution.sections) {
      await expect(card.getByRole('heading', { name: section.title, exact: true })).toBeVisible();
      await expect(card.getByText(section.summary, { exact: true })).toBeVisible();
    }
    expect(state.chatBodies).toHaveLength(0);
    expect(state.deletions).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-six-rubriques.png`), fullPage: true });

    const contextSummary = card.locator('summary').filter({ hasText: /^Contexte et orientations du dossier$/ });
    await contextSummary.focus();
    await page.keyboard.press('Enter');
    await expect(card.getByText(fixture.parsedResult.payload.summary, { exact: true })).toBeVisible();
    for (const section of resolution.sections) {
      const region = card.getByRole('region', { name: section.title, exact: true });
      if (section.items.length) {
        await region.locator('summary').click();
        await expect(region.locator('li')).toHaveText(section.items);
      }
    }
    await card.locator('summary').filter({ hasText: /^Références fournies/ }).click();
    const reference = resolution.supplied_references.find((item: { id: string }) => item.id === 'src-envoi');
    await expect(card.getByText(reference.reference, { exact: true })).toBeVisible();
    await expect(card.getByText('Non retenue par l’analyse', { exact: true })).toBeVisible();
    await expect(card.locator('script, a, img')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.label}-details-references.png`), fullPage: true });
    expect(state.chatBodies).toHaveLength(0);

    await card.getByRole('checkbox', { name: /Joindre analyse de dossier/ }).check();
    expect(state.chatBodies).toHaveLength(0);
    await page.getByRole('button', { name: 'Poser une question avec ces résultats', exact: true }).click();
    const input = page.getByRole('textbox', { name: `Question pour ${agentName}`, exact: true });
    await expect(input).toBeFocused();
    await expect(page.getByText('1 résultat privé sera joint à ta prochaine question.', { exact: true })).toBeVisible();
    await input.fill('Que reste-t-il à vérifier dans ce dossier ?');
    await page.getByRole('button', { name: 'Envoyer la question', exact: true }).click();
    await expect(page.getByText(reply, { exact: true })).toBeVisible();
    expect(state.chatBodies).toHaveLength(1);
    expect(state.chatBodies[0]).toMatchObject({ agent_id: fixture.agentId,
      message: 'Que reste-t-il à vérifier dans ce dossier ?', tool_result_ids: [fixture.storedRow.id] });
    expect(Object.keys(state.chatBodies[0]).sort()).toEqual(['agent_id', 'message', 'session_id', 'tool_result_ids']);
    expect(JSON.stringify(state.chatBodies[0])).not.toContain(resolution.snapshot.caseId);
    await expect(page.getByText('1 résultat privé sera joint à ta prochaine question.', { exact: true })).toHaveCount(0);

    await page.getByRole('tab', { name: /^Runs/ }).click();
    await expect(card.getByRole('checkbox')).not.toBeChecked();
    await card.getByRole('button', { name: 'Supprimer le résultat : Analyse de dossier', exact: true }).click();
    expect(state.deletions).toBe(0);
    await card.getByRole('button', { name: 'Annuler', exact: true }).click();
    expect(state.deletions).toBe(0);
    await card.getByRole('button', { name: 'Supprimer le résultat : Analyse de dossier', exact: true }).click();
    await card.getByRole('button', { name: 'Confirmer la suppression', exact: true }).click();
    await expect(page.getByText(/Aucun résultat privé disponible/)).toBeVisible();
    expect(state.deletions).toBe(1);
    expect(state.privateReads).toBeGreaterThanOrEqual(2);
    expect(state.chatBodies).toHaveLength(1);
    expect(pageErrors).toEqual([]);
    await testInfo.attach('verification-scope', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
      transport: 'Synthetic Supabase responses; no external provider',
      dataSource: 'Real qualifier → projector → PGlite → shared reader',
      receptionStatus: receipt.status, sourceSha256: receipt.sourceSha256, viewport, ...state,
    }, null, 2)) });
  });
}

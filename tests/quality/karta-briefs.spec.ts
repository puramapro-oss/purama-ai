import { test, expect, type Page, type Route } from '@playwright/test';
import type { BriefMission } from '../../src/hooks/useKartaEmployees';

const ownerId = '00000000-0000-4000-8000-000000000001';
const agentType = 'newsletter-genie';
const user = { id: ownerId, email: 'fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const agentSlugs = ['repondeur-intelligent', 'campagnes-par-courriel', 'pro-de-la-sensibilisation-au-froid',
  'newsletter-genie', 'facture-pro', 'chasseur-de-paiements', 'rapports-financiers', 'crm-intelligent',
  'machine-de-suivi', 'maitre-des-publicites', 'planificateur-d-appels', 'reservation-intelligente'];
const storageKey = `purama:karta-brief:v1:${ownerId}:${agentType}`;
const trackingStorageKey = `purama:karta-brief-tracking:v1:${ownerId}:${agentType}`;
type BriefBody = { action: string; agentType: string; submissionId?: string; requestId?: string; brief?: string };

function mission(index = 1, patch: Partial<BriefMission> = {}): BriefMission {
  return { submissionId: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000021`, agentType,
    state: 'pending', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    attemptCount: 0, run: null, ...patch };
}

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(value) });
}

async function prepare(page: Page, options: {
  onBrief?: (body: BriefBody, route: Route) => Promise<void>;
  rows?: BriefMission[];
  failSettings?: boolean;
  failStatistics?: boolean;
  failApprovals?: boolean;
} = {}) {
  let currentUser = user;
  await page.addInitScript(({ user }) => {
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
  }, { user });
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:4176') return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, currentUser);
    if (url.pathname.endsWith('/profiles')) return json(route, { user_id: currentUser.id, full_name: 'Fixture' });
    if (url.pathname.endsWith('/agents')) return json(route, agentSlugs.map((slug, index) => ({
      id: `${String(index + 10).padStart(8, '0')}-0000-4000-8000-000000000010`, slug,
      name: slug === agentType ? 'Newsletter fixture' : slug, description: 'Préparer une tâche.', category: 'ventes',
      icon: '🤖', color: null, features: [], is_active: true, is_premium: false, created_at: '2026-01-01T00:00:00Z',
    })));
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/karta_agent_state')) {
      if (request.method() === 'POST') return json(route, options.failSettings ? { message: 'private fixture error' } : null, options.failSettings ? 503 : 201);
      return json(route, agentSlugs.map(slug => ({ id: slug, user_id: currentUser.id, agent_type: slug,
        is_enabled: true, kill_switch: false, simulation_mode: false, autonomy_level: 1,
        last_run_at: null, last_run_status: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' })));
    }
    if (url.pathname.endsWith('/karta_runs') && options.failStatistics) return json(route, { message: 'private fixture error' }, 503);
    if (url.pathname.endsWith('/karta_pending_actions') && options.failApprovals) return json(route, { message: 'private fixture error' }, 503);
    if (url.pathname.endsWith('/karta-trigger')) {
      const body = request.postDataJSON() as BriefBody;
      expect(body).not.toHaveProperty('userId');
      expect(body).not.toHaveProperty('user_id');
      if (options.onBrief) return options.onBrief(body, route);
      if (body.action === 'list-briefs') return json(route, { ok: true, missions: options.rows ?? [] });
      if (body.action === 'brief-status') return json(route, { ok: true, mission: (options.rows ?? []).find(row => row.submissionId === body.submissionId) ?? null });
      throw new Error(`Unexpected mutation ${body.action}`);
    }
    return json(route, []);
  });
  return { switchUser: async (id: string) => {
    currentUser = { ...user, id, email: 'other@example.invalid' };
    await page.evaluate(async ({ id }) => {
      const modulePath = '/src/integrations/supabase/client.ts';
      const { supabase } = await import(modulePath);
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: id, exp, role: 'authenticated' }))}.local-fixture`;
      await supabase.auth.setSession({ access_token: token, refresh_token: 'local-fixture-other' });
    }, { id });
  } };
}

async function openForm(page: Page) {
  await page.goto('/dashboard/employees');
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Aucune mission enregistrée pour cet employé.')).toBeVisible();
  return dialog;
}

test('six supported agents expose a bounded, labelled brief form on mobile', async ({ page }) => {
  const requests: BriefBody[] = [];
  await prepare(page, { onBrief: async (body, route) => { requests.push(body); await json(route, { ok: true, missions: [] }); } });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/dashboard/employees');
  await expect(page.getByRole('button', { name: /^Donner une mission à / })).toHaveCount(6);
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Aucune mission enregistrée pour cet employé.')).toBeVisible();
  const input = dialog.getByLabel('Ta consigne', { exact: true });
  await expect(input).toHaveAttribute('maxlength', '8000');
  await input.fill('   ');
  await expect(dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true })).toBeDisabled();
  expect(requests.filter(body => body.action === 'submit-brief')).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('double click sends one immutable request and stores only recovery identifiers', async ({ page }) => {
  const writes: BriefBody[] = [];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let accepted: BriefMission | null = null;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes.push(body);
      await held;
      accepted = mission(1, { submissionId: body.submissionId! });
      return json(route, { ok: true, accepted: true, mission: accepted, dispatch: { state: 'queued', executionKey: 'opaque-fixture' } });
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: accepted ? [accepted] : [] } : { ok: true, mission: accepted });
  } });
  const dialog = await openForm(page);
  const privateText = 'Préparer la lettre confidentielle pour les contacts autorisés.';
  await dialog.getByLabel('Ta consigne').fill(privateText);
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).dblclick();
  await expect.poll(() => writes.length).toBe(1);
  await expect(dialog.getByLabel('Ta consigne')).toBeDisabled();
  const saved = await page.evaluate(key => localStorage.getItem(key), storageKey);
  expect(JSON.parse(saved!)).toEqual({ action: 'submit-brief', submissionId: writes[0].submissionId, requestId: writes[0].requestId });
  expect(saved).not.toContain(privateText);
  expect(page.url()).not.toContain(privateText);
  release();
  await expect(dialog.getByText('Consigne en attente', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Le lancement a été accepté. Le résultat reste à confirmer.')).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), trackingStorageKey)).toBe(writes[0].submissionId);
  expect(writes).toHaveLength(1);
});

test('a missing acknowledgement retries the same submission, request and frozen text', async ({ page }) => {
  const writes: BriefBody[] = [];
  let accepted: BriefMission | null = null;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes.push(body);
      if (writes.length === 1) return route.abort('failed');
      accepted = mission(1, { submissionId: body.submissionId! });
      return json(route, { ok: true, accepted: true, mission: accepted, dispatch: { state: 'unconfirmed' } });
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: accepted ? [accepted] : [] } : { ok: true, mission: accepted });
  } });
  const dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('  Préparer une lettre sans envoi avant validation.  ');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('La réponse du service n’est pas confirmée');
  await expect(dialog.getByLabel('Ta consigne')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Réessayer le même envoi' }).click();
  await expect(dialog.getByText('Consigne enregistrée. Le lancement n’est pas encore confirmé.')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].brief).toBe('Préparer une lettre sans envoi avant validation.');
});

test('reload recovers a committed submission without retaining its text or posting it again', async ({ page }) => {
  let writes = 0;
  let readable = true;
  let accepted: BriefMission | null = null;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes += 1;
      accepted = mission(1, { submissionId: body.submissionId! });
      readable = false;
      return route.abort('failed');
    }
    if (!readable) return json(route, { error: 'private fixture error' }, 503);
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: accepted ? [accepted] : [] } : { ok: true, mission: accepted });
  } });
  const dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('Mission privée à ne pas stocker dans le navigateur.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByText('Enregistrement à vérifier', { exact: true })).toBeVisible();
  const original = JSON.parse((await page.evaluate(key => localStorage.getItem(key), storageKey))!);
  expect(await page.evaluate(() => Object.entries(localStorage).some(([, value]) => value.includes('Mission privée à ne pas stocker')))).toBe(false);
  readable = true;
  await page.reload();
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Consigne en attente', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Ta consigne')).toHaveValue('');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey))
    .toEqual({ ...original, action: 'retry-brief' });
  expect(await page.evaluate(key => localStorage.getItem(key), trackingStorageKey)).toBe(original.submissionId);
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Réessayer le même lancement' })).toBeVisible();
  expect(writes).toBe(1);
});

test('an uncertain retry keeps its request identity even though the mission already exists', async ({ page }) => {
  const row = mission(1, { state: 'ready', attemptCount: 1 });
  const writes: BriefBody[] = [];
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'retry-brief') {
      writes.push(body);
      if (writes.length === 1) return route.abort('failed');
      return json(route, { ok: true, accepted: true, mission: row, dispatch: { state: 'queued' } });
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: [row] } : { ok: true, mission: row });
  } });
  await page.goto('/dashboard/employees');
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Reprendre cette mission' }).click();
  await expect(dialog.getByText('Lancement à vérifier', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Réessayer le même lancement' }).click();
  await expect(dialog.getByText('Le lancement a été accepté. Le résultat reste à confirmer.')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].submissionId).toBe(row.submissionId);
  expect(writes[0]).not.toHaveProperty('brief');
});

test('simulation preserves the pending mission; approval and uncertain effects never offer a replay', async ({ page }) => {
  const simulation = mission(1, { run: { id: mission(8).submissionId, status: 'success', mode: 'simulation', mock: false } });
  const approval = mission(2, { state: 'awaiting_approval', attemptCount: 1,
    run: { id: mission(9).submissionId, status: 'awaiting_approval', mode: 'live', mock: false } });
  const uncertain = mission(3, { state: 'reconciliation_required', attemptCount: 2,
    run: { id: mission(10).submissionId, status: 'partial', mode: 'live', mock: false } });
  await prepare(page, { rows: [simulation, approval, uncertain] });
  await page.goto('/dashboard/employees');
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const simulated = dialog.getByRole('article', { name: 'Mission 00000001', exact: true });
  await expect(simulated.getByText('Consigne en attente', { exact: true })).toBeVisible();
  await expect(simulated.getByText('Dernière exécution : Simulation terminée')).toBeVisible();
  await expect(simulated.getByText(/La simulation ne consomme pas/)).toBeVisible();
  await expect(dialog.getByRole('article', { name: 'Mission 00000002', exact: true }).getByRole('button', { name: 'Reprendre cette mission' })).toHaveCount(0);
  await expect(dialog.getByRole('article', { name: 'Mission 00000003', exact: true }).getByRole('button', { name: 'Reprendre cette mission' })).toHaveCount(0);
  await expect(dialog.getByText('Dernière exécution : Partiellement terminé')).toBeVisible();
  await dialog.getByRole('button', { name: 'Voir les actions à valider' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('reads pause after the bounded window and refreshing never submits a mission', async ({ page }) => {
  let reads = 0;
  const row = mission();
  await prepare(page, { onBrief: async (body, route) => {
    expect(body.action).toBe('list-briefs');
    reads += 1;
    await json(route, { ok: true, missions: [row] });
  } });
  await page.goto('/dashboard/employees');
  await page.clock.install();
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Consigne en attente', { exact: true })).toBeVisible();
  await page.clock.fastForward(31000);
  await expect(dialog.getByText(/Le suivi automatique est en pause/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Actualiser le suivi' })).toBeEnabled();
  const stopped = reads;
  await page.clock.runFor(5000);
  expect(reads).toBe(stopped);
  await dialog.getByRole('button', { name: 'Actualiser le suivi' }).click();
  await expect.poll(() => reads).toBeGreaterThan(stopped);
});

test('a busy slot is visible and a failed read is not displayed as an empty history', async ({ page }) => {
  let failRead = false;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') return json(route, { code: 'BRIEF_BUSY', error: 'private fixture value' }, 409);
    if (failRead) return json(route, { error: 'private fixture value' }, 503);
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: [] } : { ok: true, mission: null });
  } });
  const dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('Une nouvelle consigne.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Elle n’a pas été remplacée');
  await expect(dialog.getByLabel('Ta consigne')).toBeEnabled();
  await expect(dialog.getByText('private fixture value')).toHaveCount(0);
  failRead = true;
  await dialog.getByRole('button', { name: 'Actualiser le suivi' }).click();
  await expect(dialog.getByText('Impossible de vérifier les missions pour le moment. Actualise le suivi avant un nouvel envoi.')).toBeVisible();
  await expect(dialog.getByText('Aucune mission enregistrée pour cet employé.')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true })).toBeDisabled();
});

test('a late acknowledgement cannot attach to the form of a different account', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let received = false;
  const fixture = await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      received = true;
      await held;
      await json(route, { ok: true, accepted: true, mission: mission(1, { submissionId: body.submissionId! }), dispatch: { state: 'queued' } }).catch(() => {});
      return;
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: [] } : { ok: true, mission: null });
  } });
  const dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('Texte privé du premier compte.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect.poll(() => received).toBe(true);
  await fixture.switchUser('00000000-0000-4000-8000-000000000099');
  release();
  await expect(page.getByRole('dialog').getByLabel('Ta consigne')).toHaveValue('');
  await expect(page.getByRole('dialog').getByText('Aucune mission enregistrée pour cet employé.')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('Le lancement a été accepté. Le résultat reste à confirmer.')).toHaveCount(0);
});

test('employee settings, approval and statistics failures remain visible', async ({ page }) => {
  await prepare(page, { failSettings: true, failStatistics: true, failApprovals: true });
  await page.goto('/dashboard/employees');
  await page.getByRole('switch', { name: 'Activer Newsletter fixture', exact: true }).click();
  await expect(page.getByText('Impossible d’enregistrer ce réglage. Réessaie dans un instant.')).toBeVisible();
  await expect(page.getByText('Les statistiques sont momentanément indisponibles.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Impossible de charger les actions à valider pour le moment.')).toBeVisible();
  await expect(page.getByText('Exécutions (30j)', { exact: true }).locator('..')).toContainText('—');
});

test('NUL is rejected before network and a confirmed invalid admission releases the original text', async ({ page }) => {
  let writes = 0;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes += 1;
      return json(route, { code: 'INVALID', error: 'private fixture value' }, 400);
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: [] } : { ok: true, mission: null });
  } });
  const dialog = await openForm(page);
  const input = dialog.getByLabel('Ta consigne');
  await input.fill('Consigne\0non autorisée');
  await expect(dialog.getByText('La consigne contient un caractère non autorisé. Retire-le avant de l’enregistrer.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true })).toBeDisabled();
  expect(writes).toBe(0);
  await input.fill('Consigne à corriger selon la réponse du service.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByText('La consigne ou sa référence est invalide. Vérifie le texte avant de réessayer.')).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Consigne à corriger selon la réponse du service.');
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect(writes).toBe(1);
});

test('confirmed tracking survives two real reloads outside the bounded list without blocking a new mission', async ({ page }) => {
  const recent = Array.from({ length: 20 }, (_, index) => mission(index + 100, { state: 'completed', attemptCount: 1 }));
  let oldMission: BriefMission | null = null;
  let statusReads = 0;
  let writes = 0;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes += 1;
      oldMission = mission(1, { submissionId: body.submissionId! });
      await json(route, { ok: true, accepted: true, mission: oldMission, dispatch: { state: 'queued' } }, 202);
      oldMission = { ...oldMission, state: 'completed', attemptCount: 1,
        run: { id: mission(90).submissionId, status: 'success', mode: 'live', mock: false } };
      return;
    }
    if (body.action === 'list-briefs') return json(route, { ok: true, missions: oldMission ? recent : [] });
    expect(body.action).toBe('brief-status');
    if (!oldMission) return json(route, { ok: true, mission: null });
    expect(body.submissionId).toBe(oldMission!.submissionId);
    statusReads += 1;
    return json(route, { ok: true, mission: oldMission });
  } });
  let dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('Une consigne dont le suivi doit survivre aux rechargements.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect.poll(() => writes).toBe(1);
  const cardName = `Mission ${oldMission!.submissionId.slice(0, 8)}`;
  await expect(dialog.getByRole('article', { name: cardName, exact: true }).getByText('Consigne traitée', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  for (let reload = 0; reload < 2; reload += 1) {
    await page.reload();
    await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('article', { name: cardName, exact: true }).getByText('Consigne traitée', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('article')).toHaveCount(21);
    expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
    expect(await page.evaluate(key => localStorage.getItem(key), trackingStorageKey)).toBe(oldMission!.submissionId);
  }
  await dialog.getByLabel('Ta consigne').fill('Une autre mission distincte.');
  await expect(dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  expect(statusReads).toBeGreaterThanOrEqual(3);
});

test('an accepted but unconfirmed dispatch reuses its original request after reload', async ({ page }) => {
  const writes: BriefBody[] = [];
  let accepted: BriefMission | null = null;
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief' || body.action === 'retry-brief') {
      writes.push(body);
      accepted = mission(1, { submissionId: body.submissionId! });
      return json(route, { ok: true, accepted: true, mission: accepted,
        dispatch: { state: body.action === 'submit-brief' ? 'unconfirmed' : 'queued' } }, 202);
    }
    return json(route, body.action === 'list-briefs' ? { ok: true, missions: accepted ? [accepted] : [] } : { ok: true, mission: accepted });
  } });
  let dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('Préparer une simulation unique de newsletter.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByText('Lancement à vérifier', { exact: true })).toBeVisible();
  const retryReference = { action: 'retry-brief', submissionId: writes[0].submissionId, requestId: writes[0].requestId };
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey)).toEqual(retryReference);
  await expect(dialog.getByLabel('Ta consigne')).toHaveValue('');
  await page.reload();
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Réessayer le même lancement' }).click();
  await expect(dialog.getByText('Le lancement a été accepté. Le résultat reste à confirmer.')).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({ ...retryReference, agentType });
  expect(new Set(writes.map(body => body.requestId)).size).toBe(1);
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), storageKey)).toBeNull();
  expect(await page.evaluate(key => localStorage.getItem(key), trackingStorageKey)).toBe(writes[0].submissionId);
});

test('a conflict after reload keeps the rejected text and error when the original mission is recovered', async ({ page }) => {
  const writes: BriefBody[] = [];
  let originalMission: BriefMission | null = null;
  let afterReload = false;
  let releaseStatus!: () => void;
  const heldStatus = new Promise<void>(resolve => { releaseStatus = resolve; });
  await prepare(page, { onBrief: async (body, route) => {
    if (body.action === 'submit-brief') {
      writes.push(body);
      if (writes.length === 1) {
        originalMission = mission(1, { submissionId: body.submissionId! });
        return route.abort('failed');
      }
      return json(route, { code: 'BRIEF_CONFLICT', error: 'fixed fixture message' }, 409);
    }
    if (!originalMission) return json(route, body.action === 'list-briefs' ? { ok: true, missions: [] } : { ok: true, mission: null });
    if (!afterReload) return json(route, { code: 'UNAVAILABLE' }, 503);
    if (body.action === 'list-briefs') return json(route, { ok: true, missions: [] });
    expect(body.action).toBe('brief-status');
    await heldStatus;
    // A read from the previous page may already have been cancelled by the real reload.
    return json(route, { ok: true, mission: originalMission }).catch(() => {});
  } });
  let dialog = await openForm(page);
  await dialog.getByLabel('Ta consigne').fill('La consigne initiale admise par le service.');
  await dialog.getByRole('button', { name: 'Enregistrer la mission', exact: true }).click();
  await expect(dialog.getByText('Enregistrement à vérifier', { exact: true })).toBeVisible();
  afterReload = true;
  await page.reload();
  await page.getByRole('button', { name: 'Donner une mission à Newsletter fixture', exact: true }).click();
  dialog = page.getByRole('dialog');
  const rejectedText = 'Un texte différent que je veux conserver après le refus.';
  await dialog.getByLabel('Ta consigne').fill(rejectedText);
  await dialog.getByRole('button', { name: 'Réessayer le même envoi' }).click();
  const conflict = dialog.getByText('Cette demande est déjà associée à une autre consigne. Vérifie son suivi avant de continuer.');
  await expect(conflict).toBeVisible();
  releaseStatus();
  await expect(dialog.getByText('Mission d’origine — le texte ressaisi a été refusé', { exact: true })).toBeVisible();
  await expect(conflict).toBeVisible();
  await expect(dialog.getByLabel('Ta consigne')).toHaveValue(rejectedText);
  await expect(dialog.getByLabel('Ta consigne')).toHaveAttribute('readonly', '');
  await dialog.getByRole('button', { name: 'Consulter la mission d’origine', exact: true }).click();
  await expect(conflict).toBeVisible();
  await expect(dialog.getByLabel('Ta consigne')).toHaveValue(rejectedText);
  expect(writes).toHaveLength(2);
  expect(writes[1].submissionId).toBe(writes[0].submissionId);
  expect(writes[1].requestId).toBe(writes[0].requestId);
  expect(await page.evaluate(key => localStorage.getItem(key), trackingStorageKey)).toBe(writes[0].submissionId);
  await dialog.getByRole('button', { name: 'Abandonner le texte ressaisi', exact: true }).click();
  await expect(conflict).toHaveCount(0);
  await expect(dialog.getByLabel('Ta consigne')).toHaveValue('');
  await expect(dialog.getByRole('button', { name: 'Réessayer le même lancement' })).toBeVisible();
  expect(writes).toHaveLength(2);
});

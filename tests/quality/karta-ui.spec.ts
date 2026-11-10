import { test, expect, type Page, type Route } from '@playwright/test';
import { getKartaRunStatus } from '../../src/lib/karta-run-status';

const origin = 'http://127.0.0.1:4176';
const userId = '00000000-0000-4000-8000-000000000001';
const agentType = 'crm-intelligent';
const executionKey = 'opaque-execution-fixture';
const user = { id: userId, email: 'fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const agent = { id: '00000000-0000-4000-8000-000000000010', slug: agentType, name: 'CRM fixture',
  description: 'Préparer le suivi des contacts.', category: 'ventes', icon: '🤖', color: null,
  features: [], is_active: true, is_premium: false, created_at: '2026-01-01T00:00:00Z' };

function run(status: string, patch: Record<string, unknown> = {}) {
  return { id: `run-${status}`, execution_key: executionKey, user_id: userId, agent_type: agentType,
    status, mode: 'live', trigger_type: 'manual', trigger_source: 'api', input_summary: null,
    decision: null, tools_used: [], result_summary: null, error_message: null, claude_mock: false,
    duration_ms: status === 'running' || status === 'executing' ? null : 100,
    started_at: '2026-01-01T00:00:00Z', finished_at: status === 'running' || status === 'executing' ? null : '2026-01-01T00:00:01Z',
    ...patch };
}

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify(value) });
}

async function prepare(page: Page, options: {
  onRun?: (url: URL) => unknown;
  onTrigger?: () => unknown | Promise<unknown>;
  history?: ReturnType<typeof run>[];
} = {}) {
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
    if (route.request().method() === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/profiles')) return json(route, { user_id: userId, full_name: 'Fixture' });
    if (url.pathname.endsWith('/agents')) return json(route, [agent]);
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/karta-trigger')) {
      expect(route.request().postDataJSON()).toEqual({ agentType });
      return json(route, options.onTrigger ? await options.onTrigger() : { ok: true, queued: true, jobId: 'unrelated-queue-id', executionKey });
    }
    if (url.pathname.endsWith('/karta_runs')) {
      if (url.searchParams.has('execution_key')) {
        expect(url.searchParams.get('user_id')).toBe(`eq.${userId}`);
        expect(url.searchParams.get('agent_type')).toBe(`eq.${agentType}`);
        expect(url.searchParams.has('started_at')).toBe(false);
        return json(route, options.onRun?.(url) ?? null);
      }
      return json(route, options.history ?? []);
    }
    return json(route, []);
  });
}

async function chooseEmployee(page: Page) {
  await page.getByRole('button', { name: 'Commencer', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: /CRM fixture/ }).click();
  await expect(dialog.getByText('simulation', { exact: true })).toBeVisible();
  return dialog;
}

async function startFirstTask(page: Page) {
  await page.goto('/dashboard');
  const dialog = await chooseEmployee(page);
  await dialog.getByRole('button', { name: 'Embaucher CRM fixture' }).click();
  return dialog;
}

test('unknown and malformed states never become completion or an active state; legacy simulation stays explicit', () => {
  for (const status of [undefined, null, '', 'waiting_remote', 'constructor', '__proto__', 42]) {
    expect(getKartaRunStatus({ status }).phase).toBe('unknown');
    expect(getKartaRunStatus({ status }).label).toBe('Statut à vérifier');
  }
  expect(getKartaRunStatus({ status: 'success', mode: 'simulation' }).label).toBe('Simulation terminée');
  expect(getKartaRunStatus({ status: 'error', mode: 'simulation' }).label).toBe('Erreur');
});

test('running and executing keep polling until the matching execution completes', async ({ page }) => {
  let reads = 0;
  let serverStatus: 'running' | 'executing' | 'success' = 'running';
  await prepare(page, { onRun: url => {
    expect(url.searchParams.get('execution_key')).toBe(`eq.${executionKey}`);
    reads += 1;
    return run(serverStatus);
  } });
  const dialog = await startFirstTask(page);
  await expect(dialog.getByRole('heading', { name: 'CRM fixture travaille…' })).toBeVisible();
  await expect(dialog.getByText('Réussi', { exact: true })).toHaveCount(0);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
  // Keep each server state until its UI assertion has completed, even on a busy runner.
  serverStatus = 'executing';
  await expect(dialog.getByRole('heading', { name: 'CRM fixture exécute la tâche…' })).toBeVisible();
  serverStatus = 'success';
  await expect(dialog.getByRole('heading', { name: 'CRM fixture a terminé sa tâche', exact: true })).toBeVisible();
  await expect(dialog.getByText('L’exécution est terminée.', { exact: true })).toBeVisible();
  const settledReads = reads;
  await page.waitForTimeout(1700);
  expect(reads).toBe(settledReads);
});

const outcomes = [
  ['awaiting_approval', 'CRM fixture attend ta validation', 'En attente de validation'],
  ['error', 'CRM fixture a rencontré une erreur', 'Erreur'],
  ['cancelled', 'CRM fixture a interrompu la tâche', 'Annulé'],
  ['simulated', 'CRM fixture a terminé la simulation', 'Simulation terminée'],
  ['partial', 'CRM fixture a terminé une partie de la tâche', 'Partiellement terminé'],
  ['skipped', 'CRM fixture n’a pas exécuté cette tâche', 'Ignoré'],
] as const;

for (const [status, title, label] of outcomes) {
  test(`onboarding presents ${status} honestly after running, including metadata-only traces`, async ({ page }) => {
    let reads = 0;
    await prepare(page, { onRun: () => run(++reads === 1 ? 'running' : status) });
    const dialog = await startFirstTask(page);
    await expect(dialog.getByRole('heading', { name: 'CRM fixture travaille…' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(dialog.locator('div.p-3 > p')).toHaveText(/\S/);
    await expect(dialog.getByText('Réussi', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: status === 'awaiting_approval' ? 'Voir les actions à valider' : 'Voir mon équipe' })).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(2);
  });
}

test('a run from another request, owner, or agent cannot finish a new request', async ({ page }) => {
  let reads = 0;
  const mismatches = [
    { execution_key: 'previous-request' },
    { user_id: '00000000-0000-4000-8000-000000000099' },
    { agent_type: 'facture-pro' },
  ];
  await prepare(page, { onRun: url => {
    expect(url.searchParams.get('execution_key')).toBe(`eq.${executionKey}`);
    const mismatch = mismatches[reads++];
    return mismatch ? run('success', { ...mismatch, result_summary: 'Résultat étranger à cette demande' }) : run('simulated');
  } });
  const dialog = await startFirstTask(page);
  await expect(dialog.getByRole('heading', { name: 'CRM fixture a terminé la simulation' })).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('Résultat étranger à cette demande')).toHaveCount(0);
  expect(reads).toBe(4);
});

test('a response arriving after closing the modal cannot attach its run to a new attempt', async ({ page }) => {
  let release!: () => void;
  const firstResponse = new Promise<void>(resolve => { release = resolve; });
  let triggers = 0;
  const keys: string[] = [];
  await prepare(page, {
    onTrigger: async () => {
      if (++triggers === 1) {
        await firstResponse;
        return { ok: true, queued: true, executionKey: 'closed-attempt' };
      }
      return { ok: true, queued: true, executionKey };
    },
    onRun: url => { keys.push(url.searchParams.get('execution_key')!); return run('simulated'); },
  });
  const firstDialog = await startFirstTask(page);
  await expect.poll(() => triggers).toBe(1);
  await firstDialog.getByRole('button', { name: 'Close', exact: true }).click();
  const newDialog = await chooseEmployee(page);
  release();
  await expect(newDialog.getByRole('button', { name: 'Embaucher CRM fixture' })).toBeEnabled();
  await page.waitForTimeout(100);
  expect(keys).toEqual([]);
  await newDialog.getByRole('button', { name: 'Embaucher CRM fixture' }).click();
  await expect(newDialog.getByRole('heading', { name: 'CRM fixture a terminé la simulation' })).toBeVisible();
  expect(keys).toEqual([`eq.${executionKey}`]);
});

test('an old server acknowledgement without execution identity stays unconfirmed', async ({ page }) => {
  let reads = 0;
  await prepare(page, { onTrigger: () => ({ ok: true, queued: true, jobId: 'legacy-job' }),
    onRun: () => { reads += 1; return run('success'); } });
  const dialog = await startFirstTask(page);
  await expect(dialog.getByRole('heading', { name: 'Suivi de la tâche indisponible' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Consulter l’activité' })).toBeVisible();
  await expect(dialog.getByText('Réussi', { exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
  await dialog.getByRole('button', { name: 'Consulter l’activité' }).click();
  await expect(page).toHaveURL(/\/dashboard\/employees\?tab=activite$/);
  await expect(page.getByText('Aucune exécution enregistrée pour le moment. Active un employé IA pour démarrer.')).toBeVisible();
});

test('unknown status stays unconfirmed and polling stops at the waiting limit', async ({ page }) => {
  let reads = 0;
  await prepare(page, { onRun: () => { reads += 1; return run('waiting_remote'); } });
  await page.goto('/dashboard');
  const dialog = await chooseEmployee(page);
  await page.clock.install();
  await dialog.getByRole('button', { name: 'Embaucher CRM fixture' }).click();
  await expect(dialog.getByRole('heading', { name: 'CRM fixture a un résultat à vérifier' })).toBeVisible();
  await page.clock.runFor(1600);
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await page.clock.fastForward(21000);
  await expect(dialog.getByRole('heading', { name: 'La tâche prend plus de temps que prévu' })).toBeVisible();
  const readsAtTimeout = reads;
  await page.clock.runFor(3000);
  expect(reads).toBe(readsAtTimeout);
  await expect(dialog.getByText('Réussi', { exact: true })).toHaveCount(0);
});

test('a rejected admission cannot become a successful task or start result polling', async ({ page }) => {
  let reads = 0;
  await prepare(page, { onTrigger: () => ({ ok: true, queued: false, executionKey }),
    onRun: () => { reads += 1; return run('success'); } });
  const dialog = await startFirstTask(page);
  await expect(dialog.getByText('Le démarrage de la tâche n’a pas été confirmé. Consulte l’activité avant de réessayer.')).toBeVisible();
  await expect(dialog.getByText('Réussi', { exact: true })).toHaveCount(0);
  expect(reads).toBe(0);
});

test('activity history distinguishes final, active, pending, simulation, and unknown states', async ({ page }) => {
  const labels = [
    ['success', 'Réussi'], ['running', 'En cours'], ['executing', 'Exécution en cours'],
    ...outcomes.map(([status, , label]) => [status, label]), ['waiting_remote', 'Statut à vérifier'],
  ];
  await prepare(page, { history: [
    ...labels.map(([status]) => run(status, { result_summary: `Résumé ${status}` })),
    run('cancelled', { id: 'metadata-only-run' }),
  ] });
  await page.goto('/dashboard/employees');
  await page.getByRole('button', { name: "Timeline d'activité" }).click();
  for (const [status, label] of labels) {
    const row = page.getByText(`Résumé ${status}`, { exact: true }).locator('..');
    await expect(row.getByText(label, { exact: true })).toBeVisible();
    if (status !== 'running') await expect(row.getByText('En cours', { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('La tâche a été annulée. Consulte l’activité pour vérifier les actions déjà effectuées.')).toBeVisible();
});

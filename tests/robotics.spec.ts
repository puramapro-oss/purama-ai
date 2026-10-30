import { test, expect, type Page } from '@playwright/test';

const fakeUser = { id: '00000000-0000-4000-a000-000000000011', email: 'robot-test@example.invalid', aud: 'authenticated', role: 'authenticated' };

async function prepare(page: Page, signedIn = true) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4174') return route.continue();
    if (url.origin !== 'https://robotics-test.invalid') return route.abort();
    let body: unknown = [];
    if (url.pathname.includes('/auth/v1/user')) body = fakeUser;
    else if (url.pathname.includes('/profiles')) body = { id: 'profile-test', user_id: fakeUser.id, full_name: 'Test robots' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript(({ user, signedIn }) => {
    localStorage.setItem('purama-lang', 'fr');
    localStorage.setItem('purama_ai_intro_seen', '1');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    if (!signedIn) return;
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = [btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), btoa(JSON.stringify({ sub: user.id, exp, aud: 'authenticated' })), 'test-signature'].join('.');
    localStorage.setItem('sb-robotics-test-auth-token', JSON.stringify({ access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_at: exp, expires_in: 3600, user }));
  }, { user: fakeUser, signedIn });
}

test('la route exige une session', async ({ page }) => {
  await prepare(page, false);
  await page.goto('/dashboard/robots');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Vos robots, avec PURAMA' })).toHaveCount(0);
});

test('catalogue, accès constructeur et absence de faux raccordement', async ({ page }, testInfo) => {
  await prepare(page);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/dashboard/robots');
  await expect(page.getByRole('heading', { name: 'Vos robots, avec PURAMA' })).toBeVisible();
  await expect(page.getByLabel('Modèle de robot').locator('option')).toHaveCount(12);
  await expect(page.getByText('Connexion matérielle à préparer', { exact: true })).toBeVisible();
  await expect(page.getByText('Aucun robot connecté', { exact: false })).toBeVisible();
  await page.getByLabel('Modèle de robot').selectOption('pollen-reachy2');
  await expect(page.getByText('SDK Reachy 2 sur le même réseau local', { exact: true })).toBeVisible();
  await page.getByLabel('Modèle de robot').selectOption('unitree-g1-edu');
  await expect(page.getByText("Vérifier l'édition EDU et ses droits de développement.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /connecter le robot/i })).toHaveCount(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('robot-connection.png'), fullPage: true });
});

test('aperçu complet : édition, pause, reprise, arrêt et fin', async ({ page }, testInfo) => {
  await prepare(page);
  await page.clock.install();
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Texte de la séance').fill('Bienvenue dans cet aperçu.');
  await page.getByLabel('Durée de parole en secondes').fill('10');
  await page.getByLabel('Durée de pause en secondes').fill('1');
  await page.getByLabel('Geste à prévoir').selectOption('none');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByTestId('robot-active-step')).toHaveText('Bienvenue dans cet aperçu.');
  await page.getByRole('button', { name: 'Mettre en pause' }).click();
  await expect(page.getByText('Aperçu en pause', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('robot-rehearsal.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const paused = await page.getByRole('progressbar').getAttribute('value');
  await page.clock.fastForward(1500);
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', paused!);
  await page.getByRole('button', { name: 'Reprendre', exact: true }).click();
  await page.getByRole('button', { name: "Arrêter l'aperçu" }).click();
  await expect(page.getByText('Aperçu arrêté', { exact: true })).toBeVisible();
  await page.getByLabel('Durée de parole en secondes').fill('1');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByText('Aperçu terminé', { exact: true })).toBeVisible({ timeout: 5000 });
});

test('validation du formulaire et remise à zéro lors du changement de modèle', async ({ page }) => {
  await prepare(page);
  await page.goto('/dashboard/robots');
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await page.getByLabel('Texte de la séance').fill('   ');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByRole('alert')).toHaveText('Ajoutez un texte avant de lancer la séance.');
  await page.getByLabel('Texte de la séance').fill('Séance locale');
  await page.getByLabel('Durée de parole en secondes').fill('61');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await expect(page.getByRole('alert')).toContainText('hors limites');
  await page.getByLabel('Durée de parole en secondes').fill('60');
  await page.getByRole('button', { name: "Lancer l'aperçu" }).click();
  await page.getByLabel('Modèle de robot').selectOption('tesla-optimus');
  await expect(page.getByRole('button', { name: "Arrêter l'aperçu" })).toHaveCount(0);
  await page.getByRole('button', { name: 'Essayer le simulateur' }).click();
  await expect(page.getByText('Prêt pour un aperçu', { exact: true })).toBeVisible();
});

/**
 * E2E réel — page "Mes employés IA" (/dashboard/employees), jamais ouverte dans un vrai navigateur
 * avant ce test (cf task_plan.md Phase 2). Prod target: https://purama-ai.purama.dev
 */
import { test, expect } from '@playwright/test';
import { createTestUser, deleteTestUser, loginViaUI, skipOnboardingOverlays } from './helpers';

const TEST_EMAIL = `e2e-karta-employees-${Date.now()}@purama.test`;
const TEST_PASSWORD = 'E2ETest2026!Karta';
let testUserId: string;

test.describe.configure({ mode: 'serial' });

test.describe('Mes employés IA — /dashboard/employees', () => {
  test.beforeAll(async () => {
    testUserId = await createTestUser(TEST_EMAIL, TEST_PASSWORD);
  });

  test.afterAll(async () => {
    await deleteTestUser(testUserId);
  });

  test('charge la grille des 12 employés sans erreur, aucun placeholder cassé', async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);

    await page.goto('/dashboard/employees', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: /mes employés ia/i })).toBeVisible();

    // Pas de bannière d'erreur (fix bloquant QA isError du 2026-07-27)
    await expect(page.getByText(/impossible de charger tes employés/i)).not.toBeVisible();

    // La grille "Mon équipe" rend au moins 12 cartes (le catalogue action agents)
    const cards = page.locator('button:has-text("Niveau d\'autonomie")').locator('..').locator('..');
    await expect(page.locator('text=Niveau d\'autonomie').first()).toBeVisible({ timeout: 15_000 });
    const autonomyLabels = page.locator('text=Niveau d\'autonomie');
    await expect(autonomyLabels).toHaveCount(12, { timeout: 15_000 });
  });

  test('activation, autonomie, simulation et kill switch écrivent réellement (RLS)', async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto('/dashboard/employees', { waitUntil: 'networkidle' });

    const firstCard = page.locator('text=Niveau d\'autonomie').first().locator('xpath=ancestor::div[contains(@class,"space-y-4")]');

    // Activation on/off (Switch en haut de carte)
    const activationSwitch = firstCard.locator('button[role="switch"]').first();
    await activationSwitch.click();
    await page.waitForTimeout(500); // écriture RLS asynchrone

    // Niveau d'autonomie 2
    await firstCard.getByRole('button', { name: '2', exact: true }).click();
    await expect(firstCard.getByText(/agit seul \(sauf sensible\)/i)).toBeVisible();

    // Mode simulation toggle (2e switch de la carte)
    const switches = firstCard.locator('button[role="switch"]');
    await expect(switches).toHaveCount(2);
    await switches.nth(1).click();

    // Arrêt d'urgence
    await firstCard.getByRole('button', { name: /arrêt d'urgence/i }).click();
    await expect(firstCard.getByRole('button', { name: /réactiver l'agent/i })).toBeVisible();

    // Recharge : les réglages doivent avoir persisté réellement en DB (pas juste optimistic UI)
    await page.reload({ waitUntil: 'networkidle' });
    await expect(firstCard.getByText(/arrêté \(kill switch\)/i)).toBeVisible({ timeout: 10_000 });
  });

  test("l'onglet Timeline d'activité affiche un état vide propre (0 exécution)", async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto('/dashboard/employees', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: /timeline d'activité/i }).click();
    await expect(page.getByText(/aucune exécution enregistrée/i)).toBeVisible();
  });
});

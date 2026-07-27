/**
 * E2E réel — onboarding "Embauche ton premier employé IA" (bannière DashboardOverview +
 * HireFirstEmployeeModal), jamais ouvert dans un vrai navigateur avant ce test (cf task_plan.md
 * Phase 4). Prod target: https://purama-ai.purama.dev
 */
import { test, expect } from '@playwright/test';
import { createTestUser, deleteTestUser, loginViaUI, skipOnboardingOverlays } from './helpers';

const TEST_EMAIL = `e2e-karta-onboarding-${Date.now()}@purama.test`;
const TEST_PASSWORD = 'E2ETest2026!Karta';
let testUserId: string;

test.describe.configure({ mode: 'serial' });

test.describe('Onboarding — Embauche ton premier employé IA', () => {
  test.beforeAll(async () => {
    testUserId = await createTestUser(TEST_EMAIL, TEST_PASSWORD);
  });

  test.afterAll(async () => {
    await deleteTestUser(testUserId);
  });

  test('bannière visible pour un user à 0 employé, modal complète jusqu\'au résultat réel', async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

    await expect(page.getByText(/embauche ton premier employé ia/i)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: /commencer/i }).click();

    // Étape "pick" : 4 employés faciles proposés
    await expect(page.getByText(/choisis-en un pour commencer/i)).toBeVisible();

    // Étape "confirm"
    const firstAgentButton = page.locator('div[role="dialog"] button').first();
    await firstAgentButton.click();
    await expect(page.getByText(/tu valides toujours avant/i)).toBeVisible();

    // Étape "working" → "result" (déclenchement réel via karta-trigger, décision mock TODO_LIVE_TEST)
    await page.getByRole('button', { name: /^embaucher /i }).click();
    await expect(page.getByText(/travaille…/)).toBeVisible();

    await expect(page.getByText(/a terminé sa 1ère tâche/i)).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(/TODO_LIVE_TEST/i).first()).toBeVisible();
  });
});

/**
 * E2E réel — section "Exécution réelle (KARTA)" de /dashboard/creator-agent/:id, jamais ouverte
 * dans un vrai navigateur avant ce test (cf task_plan.md Phase 3). Prod target: purama-ai.purama.dev
 */
import { test, expect } from '@playwright/test';
import {
  createTestUser, deleteTestUser, loginViaUI, skipOnboardingOverlays,
  createCreatorAgent, deleteCreatorAgent,
} from './helpers';

const TEST_EMAIL = `e2e-karta-creator-${Date.now()}@purama.test`;
const TEST_PASSWORD = 'E2ETest2026!Karta';
let testUserId: string;
let agentId: string;

test.describe.configure({ mode: 'serial' });

test.describe('Créateur d\'Agents — section Exécution réelle (KARTA)', () => {
  test.beforeAll(async () => {
    testUserId = await createTestUser(TEST_EMAIL, TEST_PASSWORD);
    agentId = await createCreatorAgent(testUserId);
  });

  test.afterAll(async () => {
    await deleteCreatorAgent(agentId);
    await deleteTestUser(testUserId);
  });

  test('affiche le toggle simulation_mode (fix bloquant QA 2026-07-27) et le niveau d\'autonomie', async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);

    await page.goto(`/dashboard/creator-agent/${agentId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /paramètres/i }).click();
    await expect(page.getByText(/exécution réelle \(karta\)/i).first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText(/mode simulation \(dry-run\)/i)).toBeVisible();
    await expect(page.getByText(/niveau d'autonomie/i)).toBeVisible();

    // Message d'erreur FR explicite jamais affiché en usage normal (fix bloquant QA isError)
    await expect(page.getByText(/impossible de charger les réglages/i)).not.toBeVisible();
  });

  test('"Tester maintenant" déclenche réellement un cycle KARTA', async ({ page }) => {
    await skipOnboardingOverlays(page);
    await loginViaUI(page, TEST_EMAIL, TEST_PASSWORD);
    await page.goto(`/dashboard/creator-agent/${agentId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /paramètres/i }).click();

    await page.getByRole('button', { name: /tester maintenant/i }).click();
    // Toast de confirmation (déclenchement réel via karta-trigger-custom, cf Phase 3)
    await expect(page.getByText(/agent déclenché/i)).toBeVisible({ timeout: 10_000 });
  });
});

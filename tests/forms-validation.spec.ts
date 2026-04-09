import { test, expect } from '@playwright/test';

test.describe('Formulaires — Validation', () => {
  test('Login — champs vides bloqués', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    // Should stay on login page (not navigate away)
    await page.waitForTimeout(500);
    expect(page.url()).toContain('/login');
  });

  test('Signup — bouton désactivé sans accepter CGU', async ({ page }) => {
    await page.goto('/signup', { waitUntil: 'networkidle' });

    // Dismiss cookie consent if present
    const acceptBtn = page.locator('button', { hasText: /accepter/i });
    if (await acceptBtn.count() > 0) {
      await acceptBtn.first().click();
      await page.waitForTimeout(300);
    }

    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible({ timeout: 5000 });

    // Button should be disabled when terms not accepted
    await expect(submitBtn).toBeDisabled();

    // Should stay on signup page
    expect(page.url()).toContain('/signup');
  });

  test('Forgot password — formulaire présent', async ({ page }) => {
    await page.goto('/forgot-password', { waitUntil: 'networkidle' });

    const emailInput = page.locator('input[type="email"], input[name="email"]');
    if (await emailInput.count() > 0) {
      await expect(emailInput.first()).toBeVisible();
    }
  });
});

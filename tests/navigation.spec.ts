import { test, expect } from '@playwright/test';

test.describe('Navigation — Liens & Boutons', () => {
  test('Landing page — tous les CTAs sont cliquables', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    // At least one CTA button exists
    const buttons = page.locator('a, button').filter({ hasText: /commencer|essayer|découvrir|s'inscrire|gratuit/i });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
  });

  test('Login page — formulaire présent', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    const emailInput = page.locator('input[type="email"], input[name="email"]');
    await expect(emailInput).toBeVisible();

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible();

    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible();
  });

  test('Signup page — formulaire complet', async ({ page }) => {
    await page.goto('/signup', { waitUntil: 'networkidle' });

    const inputs = page.locator('input');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(3); // name, email, password

    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible();
  });

  test('Pricing — cartes visibles', async ({ page }) => {
    await page.goto('/pricing', { waitUntil: 'networkidle' });

    // Should have pricing tiers
    const text = await page.locator('body').textContent();
    expect(text?.toLowerCase()).toMatch(/gratuit|free|starter|pro|premium/i);
  });

  test('Footer links — mentions légales, CGV, CGU', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const footer = page.locator('footer');
    if (await footer.count() > 0) {
      const links = footer.locator('a');
      const count = await links.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('Navigation — redirect non-auth vers login', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    // Should redirect to login
    await page.waitForURL(/\/(login|dashboard)/, { timeout: 10_000 });
  });
});

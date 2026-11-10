import { test, expect } from './public/fixtures';

test.describe('Navigation — Liens & Boutons', () => {
  test('Landing page — le CTA principal ouvre le formulaire d’inscription', async ({ page }) => {
    await page.goto('/', { waitUntil: 'networkidle' });

    const signup = page.locator('#hero').getByRole('link', { name: 'Commencer gratuitement', exact: true });
    await expect(signup).toHaveAttribute('href', '/signup');
    await signup.click();
    await expect(page).toHaveURL(/\/signup$/);
    await expect(page.getByRole('heading', { name: 'Créer un compte', exact: true })).toBeVisible();
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

    for (const field of ['#fullName', '#email', '#password', '#confirmPassword']) {
      await expect(page.locator(field)).toBeVisible();
    }

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
    await expect(footer).toHaveCount(1);
    for (const path of ['/mentions-legales', '/cgv', '/cgu']) {
      const link = footer.locator(`a[href="${path}"]`);
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAccessibleName(/\S/);
    }
  });

  test('Navigation — redirect non-auth vers login', async ({ page }) => {
    await page.goto('/dashboard', { waitUntil: 'networkidle' });
    // Should redirect to login
    await expect(page).toHaveURL(/\/login$/, { timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Se connecter', exact: true })).toBeVisible();
  });
});

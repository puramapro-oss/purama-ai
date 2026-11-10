import { test, expect } from './public/fixtures';

test.describe('Formulaires — Validation', () => {
  test('Login — champs vides bloqués', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });

    await expect(page.getByLabel('Email', { exact: true })).toHaveAttribute('required', '');
    const submitBtn = page.locator('button[type="submit"]');
    await submitBtn.click();

    expect(await page.locator('form').evaluate(form => (form as HTMLFormElement).checkValidity())).toBe(false);
    await expect(page).toHaveURL(/\/login$/);
  });

  test('Signup — bouton désactivé sans accepter CGU', async ({ page }) => {
    await page.goto('/signup', { waitUntil: 'networkidle' });

    await expect(page.getByRole('checkbox')).not.toBeChecked();
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
    await expect(emailInput).toBeVisible();
    await expect(page.getByRole('button', { name: 'Envoyer le lien', exact: true })).toBeVisible();
  });
});

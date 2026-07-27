import type { Page } from '@playwright/test';

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://auth.purama.dev';
export const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_SERVICE_ROLE) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY doit être fourni via variable d\'environnement (jamais en dur dans le code).');
}

/** Skip les overlays de 1ère visite (intro cinématique, cookies, tutoriel) qui masqueraient la page testée. */
export async function skipOnboardingOverlays(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('intro_seen', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
  });
}

export async function createTestUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`createTestUser(${email}) failed: ${res.status} ${await res.text()}`);
  const user = await res.json();
  return user.id as string;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: SUPABASE_SERVICE_ROLE, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}` },
  });
}

export async function loginViaUI(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login', { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/dashboard/, { timeout: 15_000 });
}

/** Insère une ligne creator_agents réelle (service-role) — plus rapide que passer par le flow UI de création. */
export async function createCreatorAgent(userId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/creator_agents`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Content-Type': 'application/json',
      'Accept-Profile': 'purama_ai',
      'Content-Profile': 'purama_ai',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: userId,
      name: '[TEST] Agent Playwright',
      slug: `test-playwright-${Date.now()}`,
      system_prompt: 'Agent de test Playwright — vérifie la section Exécution réelle (KARTA).',
      karta_enabled: true,
      is_active: true,
      tools_enabled: [],
      ...overrides,
    }),
  });
  if (!res.ok) throw new Error(`createCreatorAgent failed: ${res.status} ${await res.text()}`);
  const [row] = await res.json();
  return row.id as string;
}

export async function deleteCreatorAgent(agentId: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/creator_agents?id=eq.${agentId}`, {
    method: 'DELETE',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
      'Accept-Profile': 'purama_ai',
      'Content-Profile': 'purama_ai',
    },
  });
}

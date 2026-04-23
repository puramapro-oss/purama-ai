/**
 * E2E test — DocuSeal hub contract flow
 *
 * Prod target: https://purama-ai.purama.dev
 *
 * Steps:
 *  1. Seed test user via Supabase admin (auto-confirmed)
 *  2. Login as test user
 *  3. Navigate to /ambassadeur/rejoindre
 *  4. Wizard step 1: select Bronze
 *  5. Wizard step 2: fill form
 *  6. Wizard step 3: accept CGU + submit
 *  7. Assert step 4 confirmation screen
 *  8. Assert DB: contract row inserted with status='sent'
 *  9. Simulate DocuSeal signature via Rails runner (mark both submitters completed)
 * 10. Wait webhook propagation, assert status='signed'
 * 11. Promote test user to admin → login → /admin/contracts → assert contract visible
 * 12. Cleanup: delete test user + test contract + test DocuSeal submission
 */

import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://auth.purama.dev';
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3NDA1MjQ4MDAsImV4cCI6MTg5ODI5MTIwMH0.asa0EUp9l3iubVW_1cJ5vGcEFxv6GX10G9Mvy8UzMTc';
const DOCUSEAL_URL = 'https://docuseal.purama.dev';
const DOCUSEAL_TOKEN = '540df00b0887a9e038406bc02dd25641';

const TEST_EMAIL = `e2e-docuseal-${Date.now()}@purama.test`;
const TEST_PASSWORD = 'E2ETest2026!Purama';
const TEST_NAME = 'E2E Test User';

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
  db: { schema: 'purama_ai' },
});

let testUserId: string;
let testContractId: string | null = null;
let testSubmissionId: number | null = null;

test.describe.configure({ mode: 'serial' });

test.describe('DocuSeal E2E — Ambassador contract flow', () => {
  test.beforeAll(async () => {
    // 1. Seed test user via Auth admin
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: TEST_NAME },
      }),
    });
    if (!res.ok) throw new Error(`User seed failed: ${res.status} ${await res.text()}`);
    const user = await res.json();
    testUserId = user.id;
    console.log(`✅ Test user created: ${TEST_EMAIL} (${testUserId})`);
  });

  test('1-7 · Ambassadeur flow — wizard Bronze → submit → confirmation', async ({ page }) => {
    // Pre-set localStorage to skip CinematicIntro + CookieConsent overlays
    await page.addInitScript(() => {
      localStorage.setItem('intro_seen', 'true');
      localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
      localStorage.setItem('purama-pwa-banner-dismissed', '1');
      localStorage.setItem('purama_ai_tutorial_completed', 'true');
      sessionStorage.setItem('purama_affirmation_shown', 'true');
    });

    // Login
    await page.goto('/login');
    await page.getByLabel(/email/i).first().fill(TEST_EMAIL);
    await page.getByLabel(/mot de passe|password/i).first().fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').first().click();

    // Wait for successful login (redirect away from /login)
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    // Go to /ambassadeur/rejoindre
    await page.goto('/ambassadeur/rejoindre');
    await expect(page.getByText(/rejoins les ambassadeurs/i)).toBeVisible({ timeout: 15_000 });

    // Step 1 — select Bronze (CardTitle shows exact text "Bronze")
    // Click the H3/CardTitle's parent Card element
    const bronzeTitle = page.getByRole('heading', { name: /^Bronze$/ });
    await expect(bronzeTitle).toBeVisible({ timeout: 10_000 });
    // Click on the card (closest ancestor with cursor-pointer class)
    await bronzeTitle.click();
    // Wait for selected state (ring-primary class appears)
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Continuer$/ }).click();

    // Step 2 — fill form
    // DOM order of text inputs on the wizard step 2:
    // [0] Nom complet, [1] Téléphone, [2] Adresse,
    // [3] Code postal, [4] Ville, [5] Pays, [6] SIRET, [7] IBAN
    await page.waitForSelector('text=Tes informations', { timeout: 10_000 });
    const textInputs = page.locator('input').locator('visible=true').and(
      page.locator(':not([type=password]):not([type=checkbox]):not([type=hidden]):not([type=submit])')
    );
    const count = await textInputs.count();
    expect(count).toBeGreaterThanOrEqual(8);
    await textInputs.nth(0).fill(TEST_NAME);
    await textInputs.nth(2).fill('12 rue de la Chapelle');
    await textInputs.nth(3).fill('25560');
    await textInputs.nth(4).fill('Frasne');
    await textInputs.nth(7).fill('FR7630003035409876543210972');
    await page.getByRole('button', { name: /continuer/i }).click();

    // Step 3 — review + CGU + submit
    await expect(page.getByText(/Revue & signature/i)).toBeVisible({ timeout: 10_000 });
    await page.locator('button[role="checkbox"]').first().click();
    await page.getByRole('button', { name: /signer le contrat/i }).click();

    // Step 4 — confirmation
    await expect(page.getByText(/contrat envoyé par email/i)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(TEST_EMAIL)).toBeVisible();
  });

  test('8 · DB: contract row inserted with status sent', async () => {
    // Wait briefly for DB write to commit
    await new Promise(r => setTimeout(r, 2_000));
    const { data, error } = await admin
      .from('contracts')
      .select('*')
      .eq('user_id', testUserId)
      .eq('template_slug', 'ambassadeur-bronze')
      .maybeSingle();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.status).toBe('sent');
    expect(data!.docuseal_submission_id).toBeTruthy();
    expect(data!.commission_rate).toBe(10);
    testContractId = data!.id;
    testSubmissionId = data!.docuseal_submission_id;
    console.log(`✅ Contract ${testContractId} — submission #${testSubmissionId}`);

    // Signers exist
    const { data: signers } = await admin
      .from('contract_signers').select('*').eq('contract_id', testContractId!);
    expect(signers?.length).toBeGreaterThanOrEqual(2);
  });

  test('9 · Simulate DocuSeal signature — both submitters complete', async () => {
    expect(testSubmissionId).not.toBeNull();

    // Fetch submission with submitters
    const res = await fetch(`${DOCUSEAL_URL}/api/submissions/${testSubmissionId}`, {
      headers: { 'X-Auth-Token': DOCUSEAL_TOKEN },
    });
    expect(res.status).toBe(200);
    const sub = await res.json();
    expect(sub.submitters?.length).toBeGreaterThanOrEqual(2);

    // Mark each submitter as completed via PUT /api/submitters/:id
    for (const submitter of sub.submitters) {
      const ack = await fetch(`${DOCUSEAL_URL}/api/submitters/${submitter.id}`, {
        method: 'PUT',
        headers: {
          'X-Auth-Token': DOCUSEAL_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ completed: true }),
      });
      expect(ack.ok).toBeTruthy();
    }
    console.log(`✅ Simulated signatures for ${sub.submitters.length} submitters`);
  });

  test('10 · Webhook propagation — contract status → signed', async () => {
    // Poll DB for status change
    let status = '';
    let signedAt: string | null = null;
    for (let i = 0; i < 30; i++) {
      const { data } = await admin
        .from('contracts')
        .select('status, signed_at, pdf_original_url, ots_stamp_hash')
        .eq('id', testContractId!)
        .single();
      if (data?.status === 'signed') {
        status = data.status;
        signedAt = data.signed_at;
        console.log(`✅ Contract signed at ${signedAt}`);
        break;
      }
      await new Promise(r => setTimeout(r, 2_000));
    }
    expect(status).toBe('signed');
    expect(signedAt).not.toBeNull();

    // Audit trail contains 'signed' event
    const { data: events } = await admin
      .from('contract_events').select('event_type')
      .eq('contract_id', testContractId!)
      .eq('event_type', 'signed');
    expect(events?.length).toBeGreaterThan(0);
  });

  test('11 · Admin view — /admin/contracts shows the test contract', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('intro_seen', 'true');
      localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
      localStorage.setItem('purama-pwa-banner-dismissed', '1');
      localStorage.setItem('purama_ai_tutorial_completed', 'true');
      sessionStorage.setItem('purama_affirmation_shown', 'true');
    });
    // Promote test user to admin
    const { error: promoteErr } = await admin
      .schema('purama_ai' as never)
      .from('user_roles' as never)
      .upsert({ user_id: testUserId, role: 'admin' }, { onConflict: 'user_id,role' });
    if (promoteErr) {
      // Try insert if upsert unique constraint doesn't exist
      await admin.schema('purama_ai' as never).from('user_roles' as never)
        .insert({ user_id: testUserId, role: 'admin' });
    }

    // Login fresh
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByLabel(/email/i).first().fill(TEST_EMAIL);
    await page.getByLabel(/mot de passe|password/i).first().fill(TEST_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    // Navigate to admin contracts
    await page.goto('/admin/contracts');
    await expect(page.getByText(/contrats.*docuseal hub/i)).toBeVisible({ timeout: 20_000 });

    // The contract should be visible in the table
    await expect(page.locator('table').getByText('ambassadeur-bronze').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('table').getByText(/sign/i).first()).toBeVisible();
  });

  test.afterAll(async () => {
    // Cleanup — keep backups by default; only cleanup if CLEANUP=true
    if (process.env.CLEANUP === 'true') {
      if (testContractId) {
        await admin.from('contracts').delete().eq('id', testContractId);
      }
      if (testSubmissionId) {
        await fetch(`${DOCUSEAL_URL}/api/submissions/${testSubmissionId}`, {
          method: 'DELETE',
          headers: { 'X-Auth-Token': DOCUSEAL_TOKEN },
        }).catch(() => {});
      }
      if (testUserId) {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${testUserId}`, {
          method: 'DELETE',
          headers: { 'apikey': SUPABASE_SERVICE_ROLE, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE}` },
        }).catch(() => {});
      }
      console.log('🧹 Cleanup done');
    } else {
      console.log(`🗂 Test artifacts preserved. User: ${TEST_EMAIL} · Contract: ${testContractId} · Submission: ${testSubmissionId}`);
    }
  });
});

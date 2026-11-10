import { test, expect, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

const path = '/dashboard/partner-agent/prospects';
const userId = '00000000-0000-4000-8000-000000000001';
const prospectId = '00000000-0000-4000-8000-000000000011';
const emailId = '00000000-0000-4000-8000-000000000031';
const approvalVersion = '00000000-0000-4000-8000-000000000041';
const providerMessageId = 'fixture-provider-accepted-1';
const probePrefix = '/__outreach-preview-probe__/';
const probeHost = 'outreach-preview-attacker.example.invalid';
const user = { id: userId, email: 'fixture@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const prospect = {
  id: prospectId, user_id: userId, name: 'Camille Fixture', email: 'prospect@example.invalid',
  status: 'ready_to_contact', type: 'influencer', niche: 'Fixture', source: 'manual',
  website: null, social_links: {}, tags: [], followers_count: null, found_by_ai: false,
  ai_score: null, ai_reasoning: null, has_replied: false, relance_count: 0,
  first_contact_at: null, last_contact_at: null, next_action_at: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
};
const benignHtml = '<p id="outreach-preview-fixture">Bonjour Camille, voici le partenariat proposé.</p>';
const hostileHtml = `${benignHtml}
<script>
  window.__outreachPreviewExecuted = true;
  try { parent.__outreachPreviewEscaped = true; } catch (_) {}
  parent.postMessage('outreach-preview-executed', '*');
  try { top.location.href = 'https://${probeHost}/top-navigation'; } catch (_) {}
</script>
<img src="https://${probeHost}/pixel" onerror="parent.postMessage('outreach-preview-executed', '*')">
<meta http-equiv="refresh" content="0;url=${origin}${probePrefix}refresh">
`;

// A service worker must not bypass the context's interception of remote requests.
test.use({ serviceWorkers: 'block' });

async function json(route: Route, value: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
    body: JSON.stringify(value) });
}

type Outcome = 'sent' | 'unknown' | 'stale_version' | 'missing_proof';
async function prepare(page: Page, options: { outcome?: Outcome; hostile?: boolean; deferApproval?: boolean } = {}) {
  const calls: Record<string, unknown>[] = [];
  const probeRequests: string[] = [];
  const unexpectedFrameNavigations: string[] = [];
  let currentProspect = { ...prospect };
  let releaseApproval = () => {};
  const approvalGate = new Promise<void>(resolve => {
    releaseApproval = resolve;
    if (!options.deferApproval) resolve();
  });
  const approval = { version: approvalVersion, from: 'Fixture Sender <sender@example.invalid>',
    to: prospect.email, subject: 'Partenariat — aperçu figé', body_html: options.hostile ? hostileHtml : benignHtml };

  await page.addInitScript(({ user }) => {
    if (window !== window.top) return;
    localStorage.setItem('purama_ai_intro_seen', '1');
    sessionStorage.setItem('purama_affirmation_shown', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1');
    localStorage.setItem('purama_ai_tutorial_completed', 'true');
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user.id, exp: expiresAt, role: 'authenticated' }))}.local-fixture`;
    localStorage.setItem('sb-supabase-auth-token', JSON.stringify({
      access_token: token, refresh_token: 'local-fixture', token_type: 'bearer',
      expires_in: 3600, expires_at: expiresAt, user,
    }));
    const probeWindow = window as unknown as { __outreachPreviewEscaped: boolean; __outreachPreviewMessages: unknown[] };
    probeWindow.__outreachPreviewEscaped = false;
    probeWindow.__outreachPreviewMessages = [];
    window.addEventListener('message', event => {
      if (event.data === 'outreach-preview-executed') probeWindow.__outreachPreviewMessages.push(event.data);
    });
  }, { user });

  page.on('framenavigated', frame => {
    if (frame.parentFrame() && !['about:blank', 'about:srcdoc'].includes(frame.url())) {
      unexpectedFrameNavigations.push(frame.url());
    }
  });
  // Context interception also covers a popup's first request if sandboxing regresses.
  await page.context().route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === probeHost || url.pathname.startsWith(probePrefix)) {
      probeRequests.push(request.url());
      return route.abort();
    }
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/partner_prospects')) {
      expect(request.headers()['accept-profile']).toBe('purama_ai');
      expect(url.searchParams.get('user_id')).toBe(`eq.${userId}`);
      return json(route, [currentProspect]);
    }
    if (url.pathname === '/functions/v1/partner-send-outreach') {
      expect(request.method()).toBe('POST');
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push(body);
      if (body.action === 'approve') {
        expect(body).toEqual({ action: 'approve', email_id: emailId, approval_version: approvalVersion });
        await approvalGate;
        if (options.outcome === 'unknown') return json(route, {
          ok: false, status: 'unknown', email_id: emailId, reason: 'reconciliation_required', reused: false,
        }, 202);
        if (options.outcome === 'stale_version') return json(route, {
          ok: false, status: 'blocked', email_id: emailId, reason: 'stale_approval', reused: false,
        });
        if (options.outcome === 'missing_proof') return json(route, {
          ok: true, status: 'sent', email_id: emailId, reused: false,
        });
        currentProspect = { ...currentProspect, status: 'contacted' };
        return json(route, { ok: true, status: 'sent', email_id: emailId,
          message_id: providerMessageId, reused: false });
      }
      expect(body).toEqual({ prospect_id: prospectId, type: 'outreach' });
      return json(route, { ok: true, status: 'pending_approval', email_id: emailId, approval, reused: false });
    }
    return json(route, []);
  });
  await page.context().routeWebSocket('**/*', async socket => {
    const url = new URL(socket.url());
    if (url.host === new URL(origin).host) {
      socket.connectToServer(); // Only the local Vite development socket.
      return;
    }
    if (url.hostname === probeHost || url.pathname.startsWith(probePrefix)) probeRequests.push(socket.url());
    await socket.close();
  });
  return { calls, approval, probeRequests, unexpectedFrameNavigations, releaseApproval };
}

async function openApproval(page: Page) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Prospects', exact: true })).toBeVisible();
  await expect(page.getByText(prospect.name, { exact: true })).toBeVisible();
  page.once('dialog', async dialog => {
    expect(dialog.type()).toBe('confirm');
    expect(dialog.message()).toContain(prospect.email);
    await dialog.accept();
  });
  const prepared = page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === '/functions/v1/partner-send-outreach'
      && request.method() === 'POST' && request.postDataJSON()?.action !== 'approve';
  }, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Premier email de partenariat', exact: true }).click();
  const preparationResponse = await prepared;
  expect(preparationResponse.status()).toBe(200);
  expect(await preparationResponse.json()).toMatchObject({ status: 'pending_approval', email_id: emailId });
  const dialog = page.getByRole('dialog', { name: 'Valider l’email' });
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('En attente de validation', { exact: true })).toBeVisible();
  await expect(page.getByText('Le brouillon est enregistré. Aucun email n’a été envoyé.', { exact: true })).toBeVisible();
  return dialog;
}

async function expectNoSendSuccess(page: Page) {
  await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);
  await expect(page.getByText(/Email (?:déjà )?(?:transmis|envoyé)/i)).toHaveCount(0);
}

test('pending preview isolates hostile HTML, then reports acceptance only after the provider proof response', async ({ page }) => {
  // This first navigation also includes Vite's cold compilation in the isolate.
  test.setTimeout(60_000);
  const fixture = await prepare(page, { hostile: true, deferApproval: true });
  try {
    const dialog = await openApproval(page);
    await expectNoSendSuccess(page);
    await expect(dialog.getByText(fixture.approval.from, { exact: false })).toBeVisible();
    await expect(dialog.getByText(fixture.approval.to, { exact: false })).toBeVisible();
    await expect(dialog.getByText(fixture.approval.subject, { exact: false })).toBeVisible();
    const preview = dialog.locator('iframe[title="Aperçu du message à valider"]');
    await expect(preview).toHaveAttribute('sandbox', '');
    const frame = await (await preview.elementHandle())?.contentFrame();
    expect(frame).not.toBeNull();
    if (!frame) throw new Error('Approval preview frame missing');
    await expect(frame.locator('#outreach-preview-fixture')).toHaveText('Bonjour Camille, voici le partenariat proposé.');

    // A bounded observation window is intentional: meta refresh has delay zero.
    // Rejected requests are counted, so interception cannot disguise a CSP failure.
    await page.waitForTimeout(500);
    await expect(frame.locator('#outreach-preview-fixture')).toBeVisible();
    await expect(frame.locator('#outreach-preview-fixture')).toHaveText('Bonjour Camille, voici le partenariat proposé.');
    const previewDocument = await frame.evaluate(() => ({
      locationHref: location.href,
      documentUrl: document.URL,
      readyState: document.readyState,
      origin: location.origin,
      scriptExecuted: Boolean((window as Window & { __outreachPreviewExecuted?: boolean }).__outreachPreviewExecuted),
    }));
    console.info('[outreach-preview-diagnostic]', JSON.stringify({ playwrightFrameUrl: frame.url(), ...previewDocument }));
    expect(fixture.probeRequests).toEqual([]);
    expect(fixture.unexpectedFrameNavigations).toEqual([]);
    // Playwright can omit URL metadata for this opaque frame. Require the
    // browser document itself to remain the fully loaded, sandboxed srcdoc.
    expect(previewDocument).toEqual({
      locationHref: 'about:srcdoc',
      documentUrl: 'about:srcdoc',
      readyState: 'complete',
      origin: 'null',
      scriptExecuted: false,
    });
    await expect(page).toHaveURL(`${origin}${path}`);
    expect(page.context().pages()).toHaveLength(1);
    expect(await frame.evaluate(() => Boolean((window as Window & { __outreachPreviewExecuted?: boolean }).__outreachPreviewExecuted))).toBe(false);
    expect(await page.evaluate(() => {
      const probeWindow = window as unknown as { __outreachPreviewEscaped: boolean; __outreachPreviewMessages: unknown[] };
      return { escaped: probeWindow.__outreachPreviewEscaped, messages: probeWindow.__outreachPreviewMessages };
    })).toEqual({ escaped: false, messages: [] });

    const accepted = page.waitForResponse(response => response.url().endsWith('/functions/v1/partner-send-outreach')
      && response.request().postDataJSON()?.action === 'approve');
    const approve = dialog.getByRole('button', { name: 'Approuver et envoyer', exact: true });
    await approve.click();
    await expect.poll(() => fixture.calls.filter(call => call.action === 'approve').length).toBe(1);
    await expect(approve).toBeDisabled();
    await expectNoSendSuccess(page);
    fixture.releaseApproval();
    expect(await (await accepted).json()).toMatchObject({ status: 'sent', message_id: providerMessageId });
    await expect(page.getByText('Email transmis', { exact: true })).toBeVisible();
    await expect(page.getByText('Le service d’envoi a confirmé la prise en charge du message.', { exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(fixture.calls).toHaveLength(2);
    expect(fixture.probeRequests).toEqual([]);
  } finally {
    fixture.releaseApproval();
  }
});

test('an unknown approval result stays a warning with no success claim or automatic resend', async ({ page }) => {
  const fixture = await prepare(page, { outcome: 'unknown' });
  const dialog = await openApproval(page);
  await expectNoSendSuccess(page);
  await dialog.getByRole('button', { name: 'Approuver et envoyer', exact: true }).click();
  await expect(page.getByText('Envoi à vérifier', { exact: true })).toBeVisible();
  await expect(page.getByText('Le résultat doit être vérifié auprès du service d’envoi. Aucun renvoi automatique ne sera effectué.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-sonner-toast][data-type="warning"]')).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await expectNoSendSuccess(page);
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls.filter(call => call.action === 'approve')).toHaveLength(1);
});

test('a refused draft version is shown as blocked rather than approved or sent', async ({ page }) => {
  const fixture = await prepare(page, { outcome: 'stale_version' });
  const dialog = await openApproval(page);
  await dialog.getByRole('button', { name: 'Approuver et envoyer', exact: true }).click();
  await expect(page.getByText('Envoi bloqué', { exact: true })).toBeVisible();
  await expect(page.getByText('Ce brouillon a changé. Rechargez son aperçu avant de le valider.', { exact: true })).toBeVisible();
  await expectNoSendSuccess(page);
  expect(fixture.calls).toHaveLength(2);
});

test('a sent status without provider proof cannot become a success toast', async ({ page }) => {
  const fixture = await prepare(page, { outcome: 'missing_proof' });
  const dialog = await openApproval(page);
  const approve = dialog.getByRole('button', { name: 'Approuver et envoyer', exact: true });
  await approve.click();
  await expect(page.getByText('Validation non confirmée', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirmation du service d’envoi absente', { exact: true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(approve).toBeEnabled();
  await expectNoSendSuccess(page);
  expect(fixture.calls).toHaveLength(2);
});

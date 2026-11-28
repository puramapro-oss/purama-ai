import { test, expect, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

const owner = '00000000-0000-4000-8000-000000000001';
const prospectId = '00000000-0000-4000-8000-000000000011';
const logId = '00000000-0000-4000-8000-000000000021';
const approvalId = '00000000-0000-4000-8000-000000000031';
const contractId = '00000000-0000-4000-8000-000000000041';
const user = { id: owner, email: 'operator@example.invalid', aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' };
const prospect = { id: prospectId, user_id: owner, name: 'Journal vérifié', email: 'journal@example.invalid', type: 'media',
  status: 'contacted', website: null, social_links: {}, tags: [], ai_score: null, has_replied: true,
  reply_kind: 'human', reply_gmail_message_id: 'reply1', reply_gmail_thread_id: 'thread1',
  reply_summary: 'Une réponse humaine est disponible.', reply_received_at: '2026-11-24T12:00:00Z',
  contact_role: 'commercial', outreach_profile: 'media_affiliate',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-11-24T12:00:00Z' };
const log = { id: logId, user_id: owner, gmail_message_id: 'reply1', gmail_thread_id: 'thread1',
  from_email: prospect.email, from_name: prospect.name, subject: 'Re: Proposition média', body_preview: 'Quelle offre proposez-vous ?',
  action_taken: 'draft', category: 'partenariat', user_approved: null, ai_response: 'Proposition factuelle préparée par IAO.',
  created_at: '2026-11-24T12:00:00Z' };
const integration = { status: 'requirements_missing', missing: ['beneficiary_identity', 'catalog_binding', 'one_runtime', 'payout_runtime'],
  activation_allowed: false, payment_allowed: false, one_revision: 'a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e' };
const admission = { status: 'prepared', reused: false, admission: { id: logId, version: 1, user_id: owner,
  prospect_id: prospectId, contract_id: contractId, created_at: '2026-11-24T12:00:00Z',
  snapshot: { schema_version: 1, source: 'purama_ai_signed_media_contract', owner_id: owner, prospect_id: prospectId,
    contract_id: contractId, document: { approved_pdf_sha256: 'a'.repeat(64), approval_version: approvalId, approved_by: owner },
    contract_snapshot: { outreach_profile: 'media_affiliate', media_terms_version: '20261124', commission_first_payment: 30, commission_recurring: 30 },
    beneficiary_id: null, financial_authority: 'none', integration } }, integration };

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });
}
async function setup(page: Page, options: { blockedReply?: boolean; blockedAdmission?: boolean; failedRead?: boolean; signed?: boolean; reclassified?: boolean } = {}) {
  const calls: { endpoint: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ user }) => {
    localStorage.setItem('purama_ai_intro_seen', '1'); sessionStorage.setItem('purama_affirmation_shown', 'true');
    localStorage.setItem('cookie_consent', JSON.stringify({ essential: true, analytics: false, timestamp: Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed', '1'); localStorage.setItem('purama_ai_tutorial_completed', 'true');
    const expires_at = Math.floor(Date.now() / 1000) + 3600;
    const access_token = `${btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${btoa(JSON.stringify({ sub: user.id, exp: expires_at, role: 'authenticated' }))}.fixture`;
    localStorage.setItem('sb-supabase-auth-token', JSON.stringify({ user, access_token, refresh_token: 'fixture', token_type: 'bearer', expires_at, expires_in: 3600 }));
  }, { user });
  await page.context().route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route, null);
    if (url.pathname === '/auth/v1/user') return json(route, user);
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route, 0);
    if (url.pathname.endsWith('/subscriptions')) return json(route, { plan_type: 'free', status: 'active', has_used_trial: false, trial_ends_at: null });
    if (url.pathname.endsWith('/wallets')) return json(route, { balance: 0, total_earned: 0, total_withdrawn: 0 });
    if (url.pathname.endsWith('/partner_prospects')) {
      if (options.reclassified && url.searchParams.has('outreach_profile')) return json(route, []);
      return json(route, [{ ...prospect,
        ...(options.signed ? { status: 'contract_signed', contract_signed_at: '2026-11-24T12:00:00Z' } : {}),
        ...(options.reclassified ? { status: 'rejected', outreach_profile: 'editorial' } : {}) }]);
    }
    if (url.pathname.endsWith('/partner_active') || url.pathname.endsWith('/partner_commissions')) {
      return options.failedRead ? json(route, { message: 'fixture unavailable' }, 503) : json(route, []);
    }
    if (url.pathname.endsWith('/email_agent_logs')) return json(route, url.searchParams.has('id') ? log : []);
    if (url.pathname === '/functions/v1/partner-prepare-reply') {
      const body = request.postDataJSON() as Record<string, unknown>; calls.push({ endpoint: 'prepare', body });
      return json(route, options.blockedReply ? { status: 'blocked', reason: 'contact_suppressed' } :
        { status: 'prepared', log_id: logId, user_id: owner, prospect_id: prospectId, gmail_message_id: 'reply1' });
    }
    if (url.pathname === '/functions/v1/email-agent-send-draft') {
      const body = request.postDataJSON() as Record<string, unknown>; calls.push({ endpoint: 'email', body });
      if (body.action === 'preview') return json(route, { ok: true, status: 'ready', user_id: owner, log_id: logId,
        approval_id: approvalId, expires_at: new Date(Date.now() + 60_000).toISOString(), payload: {
          gmail_email: user.email, gmail_message_id: 'reply1', gmail_thread_id: 'thread1', gmail_draft_id: null,
          recipient: prospect.email, subject: log.subject, body: log.ai_response,
        } });
      if (body.action === 'approve') return json(route, { ok: true, status: 'approved', user_id: owner, log_id: logId, approval_id: approvalId });
      if (body.action === 'send') return json(route, { ok: true, status: 'sent', action_id: contractId,
        provider_message_id: 'fixture-provider-receipt', matches_current_preview: true });
      return json(route, { error: 'unexpected operation' }, 400);
    }
    if (url.pathname.endsWith('/rpc/partner_affiliation_candidates')) {
      calls.push({ endpoint: 'candidates', body: request.postDataJSON() as Record<string, unknown> });
      return json(route, { status: 'ready', user_id: owner, has_more: false,
        candidates: options.signed ? [{ id: prospectId, user_id: owner, name: prospect.name,
          contract_signed_at: '2026-11-24T12:00:00Z' }] : [] });
    }
    if (url.pathname.endsWith('/rpc/partner_affiliation_admission_prepare')) {
      calls.push({ endpoint: 'admission', body: request.postDataJSON() as Record<string, unknown> });
      return json(route, options.blockedAdmission ? { status: 'blocked', reason: 'signed_contract_required' } : admission);
    }
    return json(route, []);
  });
  await page.context().routeWebSocket('**/*', async socket => {
    if (new URL(socket.url()).host === new URL(origin).host) socket.connectToServer(); else await socket.close();
  });
  return { calls, errors };
}

test('partner reply opens the exact existing email approval flow and sends only after explicit review', async ({ page }) => {
  const f = await setup(page); await page.goto('/dashboard/partner-agent/prospects');
  await page.getByRole('button', { name: 'Préparer une réponse', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Ouvrir le brouillon et vérifier son état' })).toBeVisible();
  expect(f.calls).toEqual([{ endpoint: 'prepare', body: { prospect_id: prospectId, gmail_message_id: 'reply1', intent: 'request_details' } }]);
  await page.getByRole('link', { name: 'Ouvrir le brouillon et vérifier son état' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(log.ai_response, { exact: true })).toBeVisible();
  await expect(dialog.getByText(prospect.email, { exact: false }).first()).toBeVisible();
  expect(f.calls.filter(call => call.body.action === 'send')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Approuver & envoyer' }).click();
  await expect(page.getByText('Envoi confirmé par Gmail', { exact: true })).toBeVisible();
  expect(f.calls.filter(call => call.endpoint === 'email').map(call => call.body.action)).toEqual(['preview', 'approve', 'send']);
  expect(f.errors).toEqual([]);
});

test('a refusal never presents a draft approval link', async ({ page }) => {
  const f = await setup(page, { blockedReply: true }); await page.goto('/dashboard/partner-agent/prospects');
  await page.getByRole('button', { name: 'Préparer une réponse', exact: true }).click();
  await expect(page.getByText('Ce destinataire a fait opposition. Aucune réponse commerciale ne sera préparée.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ouvrir le brouillon et vérifier son état' })).toHaveCount(0);
  expect(f.calls.filter(call => call.endpoint === 'email')).toHaveLength(0); expect(f.errors).toEqual([]);
});

test('a signed media admission remains exportable after reclassification with financial activation disabled', async ({ page }) => {
  const f = await setup(page, { signed: true, reclassified: true }); await page.goto('/dashboard/partner-agent/partners');
  await page.getByRole('button', { name: 'Préparer le dossier d’affiliation' }).click();
  await expect(page.getByText(/L’affiliation et les versements restent à raccorder/)).toBeVisible();
  await expect(page.getByText('Identité du bénéficiaire vérifiée dans ONE', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter le dossier vérifié' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`PURAMA_ADMISSION_MEDIA_${logId}.json`);
  const stream = await download.createReadStream(); expect(stream).not.toBeNull();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  expect(JSON.parse(Buffer.concat(chunks).toString('utf8'))).toEqual(admission);
  expect(f.calls).toEqual([{ endpoint: 'candidates', body: { p_page: 0 } },
    { endpoint: 'admission', body: { p_prospect_id: prospectId } }]); expect(f.errors).toEqual([]);
});

test('failed partner balances stay visibly unavailable while the signed admission remains usable', async ({ page }) => {
  const f = await setup(page, { signed: true, failedRead: true, blockedAdmission: true });
  await page.goto('/dashboard/partner-agent/partners');
  await expect(page.getByRole('alert').first()).toBeVisible();
  await page.getByRole('button', { name: 'Préparer le dossier d’affiliation' }).click();
  await expect(page.getByText('Le hub de contrats doit confirmer la signature complète de cet accord.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exporter le dossier vérifié' })).toHaveCount(0);
  expect(f.calls.filter(call => call.endpoint === 'admission')).toHaveLength(1); expect(f.errors).toEqual([]);
});

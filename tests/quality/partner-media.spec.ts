import { test, expect, type Page, type Route } from '@playwright/test';
import { qualityOrigin as origin } from './quality-environment';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const ids: Record<string,string> = { [A]: '00000000-0000-4000-8000-000000000011', [B]: '00000000-0000-4000-8000-000000000012' };
const path = '/dashboard/partner-agent/prospects';
const userFor = (id: string) => ({ id, email: `${id}@example.invalid`, aud: 'authenticated', role: 'authenticated',
  app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
const rowFor = (owner: string) => ({ id: ids[owner], user_id: owner, name: owner === A ? 'Journal A' : 'Journal B',
  email: owner === A ? 'regie-a@example.invalid' : 'regie-b@example.invalid', type: 'media', status: 'identified',
  source: 'ai_search', website: 'https://journal.example/', social_links: {}, tags: [], found_by_ai: true,
  ai_score: 80, ai_reasoning: 'Régie à qualifier', followers_count: null, has_replied: false, relance_count: 0,
  contact_role: 'commercial', outreach_profile: 'media_affiliate',
  contact_evidence: { source_url: 'https://journal.example/contact', verification: 'observed_in_search_result' },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });

async function json(route: Route, value: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(value) });
}
async function prepare(page: Page, options: { deferQualification?: boolean; deferFind?: boolean; permission?: boolean; blocked?: boolean } = {}) {
  let owner = A;
  const calls: { kind: string; body: Record<string, unknown> }[] = [];
  const rows: Record<string, Record<string, unknown>> = { [A]: rowFor(A), [B]: rowFor(B) };
  if (options.permission) rows[A].email_permission = { status: 'explicit_opt_in', email: rows[A].email,
    reference: 'Message de confirmation reçu par PURAMA', consented_at: '2026-11-23T10:00:00Z' };
  let releaseQualification = () => {}; let releaseFind = () => {};
  const qualificationGate = new Promise<void>(resolve => { releaseQualification = resolve; if (!options.deferQualification) resolve(); });
  const findGate = new Promise<void>(resolve => { releaseFind = resolve; if (!options.deferFind) resolve(); });
  await page.addInitScript(({ user }) => {
    localStorage.setItem('purama_ai_intro_seen','1'); sessionStorage.setItem('purama_affirmation_shown','true');
    localStorage.setItem('cookie_consent',JSON.stringify({ essential:true,analytics:false,timestamp:Date.now() }));
    localStorage.setItem('purama-pwa-banner-dismissed','1'); localStorage.setItem('purama_ai_tutorial_completed','true');
    const expires_at = Math.floor(Date.now()/1000)+3600;
    const access_token = `${btoa(JSON.stringify({ alg:'HS256',typ:'JWT' }))}.${btoa(JSON.stringify({ sub:user.id,exp:expires_at,role:'authenticated' }))}.fixture`;
    localStorage.setItem('sb-supabase-auth-token',JSON.stringify({ user,access_token,refresh_token:'fixture',token_type:'bearer',expires_at,expires_in:3600 }));
  }, { user:userFor(A) });
  await page.context().route('**/*',async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === origin) return route.continue();
    if (url.hostname !== 'supabase.example.invalid') return route.abort();
    if (request.method() === 'OPTIONS') return json(route,null);
    if (url.pathname === '/auth/v1/user') return json(route,userFor(owner));
    if (url.pathname.endsWith('/public_weekly_actions_count')) return json(route,0);
    if (url.pathname.endsWith('/subscriptions')) return json(route,{ plan_type:'free',status:'active',has_used_trial:false,trial_ends_at:null });
    if (url.pathname.endsWith('/wallets')) return json(route,{ balance:0,total_earned:0,total_withdrawn:0 });
    if (url.pathname.endsWith('/partner_prospects')) {
      const selected = url.searchParams.get('user_id')?.replace(/^eq\./,'');
      expect([A,B]).toContain(selected);
      return json(route,[rows[selected!]]);
    }
    if (url.pathname.endsWith('/rpc/partner_prospect_qualify')) {
      expect(request.headers()['content-profile']).toBe('purama_ai');
      const body = request.postDataJSON() as Record<string, unknown>;
      calls.push({ kind:'qualification',body });
      const selected = body.p_prospect_id === ids[A] ? A : B;
      const qualification = body.p_qualification as Record<string,unknown>;
      await qualificationGate;
      if (options.blocked) return json(route,{ status:'blocked',reason:'contact_suppressed' });
      if (qualification.withdraw_permission) {
        rows[selected].email_permission = { status:'withdrawn' };
        return json(route,{ status:'permission_withdrawn' });
      }
      rows[selected] = { ...rows[selected], status:'ready_to_contact', outreach_profile:qualification.profile,
        contact_qualification: { email:rows[selected].email, source_url:qualification.source_url,
          country:qualification.country,language:qualification.language,verified_at:'2026-11-24T12:00:00Z' },
        email_permission: { status:'explicit_opt_in',email:rows[selected].email,reference:qualification.consent_reference,
          consented_at:qualification.consent_at },outreach_offer:qualification.offer };
      return json(route,{ status:'qualified',prospect:rows[selected] });
    }
    if (url.pathname === '/functions/v1/partner-find-prospects') {
      calls.push({ kind:'find',body:request.postDataJSON() as Record<string,unknown> });
      const candidate = rowFor(owner);
      await findGate;
      return json(route,{ inserted:1,skipped:0,prospects:[candidate] });
    }
    return json(route,[]);
  });
  await page.context().routeWebSocket('**/*',async socket => {
    if (new URL(socket.url()).host === new URL(origin).host) socket.connectToServer(); else await socket.close();
  });
  await page.goto(path);
  await expect(page.getByText('Journal A',{ exact:true })).toBeVisible();
  return { calls, releaseQualification, releaseFind,
    async switchAccount() {
      owner = B;
      await page.evaluate(user => {
        const expires_at = Math.floor(Date.now()/1000)+3600;
        const access_token = `${btoa(JSON.stringify({ alg:'HS256',typ:'JWT' }))}.${btoa(JSON.stringify({ sub:user.id,exp:expires_at,role:'authenticated' }))}.fixture`;
        const session = { user,access_token,refresh_token:'fixture',token_type:'bearer',expires_at,expires_in:3600 };
        localStorage.setItem('sb-supabase-auth-token',JSON.stringify(session));
        const channel = new BroadcastChannel('sb-supabase-auth-token');
        channel.postMessage({ event:'SIGNED_IN',session }); channel.close();
      },userFor(B));
      await expect(page.getByText('Journal B',{ exact:true })).toBeVisible();
      await expect(page.getByText('Journal A',{ exact:true })).toHaveCount(0);
    },
  };
}
async function fillQualification(page: Page) {
  await page.getByRole('button',{ name:'Qualifier',exact:true }).click();
  const dialog = page.getByRole('dialog',{ name:'Qualifier le contact' });
  await dialog.getByLabel('Pays du destinataire',{ exact:true }).fill('CH');
  await dialog.getByLabel('Langue de l’échange',{ exact:true }).fill('fr');
  await dialog.getByLabel('Référence vérifiable de l’accord',{ exact:true }).fill('Message entrant du 23 novembre : souhaite recevoir la proposition');
  await dialog.getByLabel('Date et heure de l’accord',{ exact:true }).fill('2026-11-23T10:00');
  await dialog.getByLabel('Nom',{ exact:true }).fill('Offre PURAMA vérifiée');
  await dialog.getByLabel('Page de présentation',{ exact:true }).fill('https://purama.example/offre');
  await dialog.getByLabel('Présentation vérifiée',{ exact:true }).fill('Présentation factuelle et disponibilité confirmée.');
  return dialog;
}

test('discovery opens without an invalid empty SelectItem and reports candidates to qualify', async ({ page }) => {
  const fixture = await prepare(page);
  const errors: string[] = []; page.on('pageerror',error => errors.push(error.message));
  await page.getByRole('button',{ name:'Trouver via IA' }).click();
  const dialog = page.getByRole('dialog',{ name:'Recherche IA de prospects' });
  await dialog.getByLabel('Requête',{ exact:true }).fill('Radios de Suisse romande');
  await dialog.getByRole('button',{ name:/Lancer la recherche|Rechercher/ }).click();
  await expect.poll(() => fixture.calls.filter(call => call.kind === 'find').length).toBe(1);
  expect(fixture.calls[0].body).toMatchObject({ query:'Radios de Suisse romande' });
  await expect(page.getByText('1 prospects ajoutés à qualifier',{ exact:true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('qualification requires deliberate proof confirmation and sends the exact media profile', async ({ page }) => {
  const fixture = await prepare(page);
  const dialog = await fillQualification(page);
  const confirmation = dialog.getByRole('checkbox');
  await expect(confirmation).not.toBeChecked();
  await expect(dialog.getByRole('button',{ name:'Enregistrer la qualification' })).toBeDisabled();
  expect(fixture.calls).toHaveLength(0);
  await confirmation.check();
  await dialog.getByLabel('Page de présentation',{ exact:true }).fill('http://purama.example/offre');
  await dialog.getByRole('button',{ name:'Enregistrer la qualification' }).click();
  await expect(page.getByText('Offre incomplète',{ exact:true }).first()).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  await dialog.getByLabel('Page de présentation',{ exact:true }).fill('https://purama.example/offre');
  await dialog.getByLabel('Présentation vérifiée',{ exact:true }).fill('Court');
  await dialog.getByRole('button',{ name:'Enregistrer la qualification' }).click();
  await expect(dialog).toBeVisible();
  expect(fixture.calls).toHaveLength(0);
  await dialog.getByLabel('Présentation vérifiée',{ exact:true }).fill('Présentation factuelle et disponibilité confirmée.');
  await dialog.getByRole('button',{ name:'Enregistrer la qualification' }).click();
  await expect(page.getByText('Contact qualifié',{ exact:true })).toBeVisible();
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0].body).toMatchObject({ p_prospect_id:ids[A],p_qualification:{ profile:'media_affiliate',role:'commercial',
    source_url:'https://journal.example/contact',country:'CH',language:'fr',offer:{ name:'Offre PURAMA vérifiée',url:'https://purama.example/offre' } } });
  expect(fixture.calls[0].body).not.toHaveProperty('user_id');
  await expect(page.getByText('Accord d’envoi enregistré',{ exact:true })).toBeVisible();
});

test('a blocked qualification remains open with no false success', async ({ page }) => {
  const fixture = await prepare(page,{ blocked:true });
  const dialog = await fillQualification(page);
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button',{ name:'Enregistrer la qualification' }).click();
  await expect(page.getByText('Qualification non confirmée',{ exact:true })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByText('Contact qualifié',{ exact:true })).toHaveCount(0);
  expect(fixture.calls).toHaveLength(1);
});

test('withdrawing permission uses the dedicated RPC and requires no invented consent', async ({ page }) => {
  const fixture = await prepare(page,{ permission:true });
  await page.getByRole('button',{ name:'Qualifier',exact:true }).click();
  const dialog = page.getByRole('dialog',{ name:'Qualifier le contact' });
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByRole('button',{ name:'Retirer l’autorisation d’envoi' }).click();
  await expect(page.getByText('Autorisation d’envoi retirée',{ exact:true })).toBeVisible();
  expect(fixture.calls[0].body).toEqual({ p_prospect_id:ids[A],p_qualification:{ withdraw_permission:true } });
  await expect(page.getByText('Accord d’envoi à renseigner',{ exact:true })).toBeVisible();
});

test('a late qualification for A cannot close or alter the form of B', async ({ page }) => {
  const fixture = await prepare(page,{ deferQualification:true });
  try {
    const dialog = await fillQualification(page);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button',{ name:'Enregistrer la qualification' }).click();
    await expect.poll(() => fixture.calls.length).toBe(1);
    await fixture.switchAccount();
    await page.getByRole('button',{ name:'Qualifier',exact:true }).click();
    const current = page.getByRole('dialog',{ name:'Qualifier le contact' });
    await current.getByLabel('Nom',{ exact:true }).fill('Offre du compte B');
    const receipt = page.waitForResponse(response => response.url().endsWith('/rpc/partner_prospect_qualify'));
    fixture.releaseQualification(); await receipt;
    await expect(current).toBeVisible();
    await expect(current.getByLabel('Nom',{ exact:true })).toHaveValue('Offre du compte B');
    await expect(page.getByText('Contact qualifié',{ exact:true })).toHaveCount(0);
  } finally { fixture.releaseQualification(); }
});

test('a late discovery for A leaves the new search of B intact', async ({ page }) => {
  const fixture = await prepare(page,{ deferFind:true });
  try {
    await page.getByRole('button',{ name:'Trouver via IA' }).click();
    let dialog = page.getByRole('dialog',{ name:'Recherche IA de prospects' });
    await dialog.getByLabel('Requête',{ exact:true }).fill('Recherche privée du compte A');
    await dialog.getByRole('button',{ name:/Lancer la recherche|Rechercher/ }).click();
    await expect.poll(() => fixture.calls.length).toBe(1);
    await fixture.switchAccount();
    await page.getByRole('button',{ name:'Trouver via IA' }).click();
    dialog = page.getByRole('dialog',{ name:'Recherche IA de prospects' });
    await dialog.getByLabel('Requête',{ exact:true }).fill('Recherche du compte B');
    const receipt = page.waitForResponse(response => response.url().endsWith('/functions/v1/partner-find-prospects'));
    fixture.releaseFind(); await receipt;
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Requête',{ exact:true })).toHaveValue('Recherche du compte B');
    await expect(page.getByText('1 prospects ajoutés à qualifier',{ exact:true })).toHaveCount(0);
  } finally { fixture.releaseFind(); }
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// These cases run the deployed SQL and its existing reservation/approval RPCs.
// No provider, mailbox, prospect or production database is contacted.
type Row = Record<string, unknown>;
const readMigration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const policy = readMigration('20261124050100_partner_media_policy');
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const prospect = '00000000-0000-4000-8000-000000000011';
const otherProspect = '00000000-0000-4000-8000-000000000012';
const token = '00000000-0000-4000-8000-000000000021';
const nextToken = '00000000-0000-4000-8000-000000000022';
const offer = { name: 'Fictional offer', url: 'https://products.example.invalid/offer', summary: 'A factual product summary supplied by the fixture operator.' };
const terms = {
  parties_identity: 'Fixture legal identities and capacity of both parties.',
  products_and_countries: 'Fixture product scope and eligible territories.',
  attribution: 'Fixture attribution conditions explicitly chosen by the operator.',
  recurrence: 'Fixture eligible recurring instalments expressly agreed.',
  payment: 'Fixture payment conditions.\nSeparate paragraph kept verbatim.',
  refunds: 'Fixture returns and refunds conditions agreed by the parties.',
  duration_termination: 'Fixture duration and termination conditions.',
  content_rights: 'Fixture content rights with the actual agreed limits.',
  costs: 'Fixture allocation of actual production and placement costs.',
  disputes: 'Fixture procedure for claims and resolution of disputes.',
};
const evidence = { source_url: 'https://publisher.example.invalid/contact', email: 'recipient@example.invalid',
  verification: 'observed_in_search_result', excerpt: 'Commercial desk: recipient@example.invalid', observed_at: '2020-01-01T00:00:00Z' };
let db: PGlite;
let oldLegacySnapshot: Row;

async function seedAccounts() {
  await db.query(`INSERT INTO purama_ai.partner_agent_config(user_id,is_active,sender_name,sender_email,company_name,
    require_approval_new_prospect,require_approval_outreach)
    VALUES ($1,true,'Fixture Sender','sender@example.invalid','Fixture Company',false,false),
      ($2,true,'Other Sender','other@example.invalid','Other Company',false,false)`, [user, other]);
  await db.query(`INSERT INTO purama_ai.email_agent_config(user_id,is_active,gmail_email,gmail_refresh_token)
    VALUES ($1,true,'sender@example.invalid','fixture-encrypted-not-used'),
      ($2,true,'other@example.invalid','fixture-encrypted-not-used')`, [user, other]);
  await db.exec("UPDATE purama_ai.partner_agent_config SET outreach_timezone='UTC',outreach_hours_start='00:00',outreach_hours_end='24:00',outreach_days=ARRAY['MO','TU','WE','TH','FR','SA','SU']");
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status)
    VALUES ($1,$2,'Fixture Recipient','recipient@example.invalid','identified'),
      ($3,$4,'Other Recipient','other-recipient@example.invalid','identified')`, [prospect, user, otherProspect, other]);
}
const signatures: Record<string, number> = {
  partner_prospect_qualify: 2, partner_contract_context: 2, partner_contract_reserve: 3,
  partner_outreach_reserve: 4, partner_outreach_save_draft: 5, partner_outreach_begin_send: 3,
  partner_outreach_approve: 3, partner_outreach_finish: 5,
  partner_contract_save: 7, partner_contract_claim: 5,
};
async function call(name: string, ...args: unknown[]): Promise<Row> {
  if (signatures[name] !== args.length) throw new Error(`Unexpected fixture RPC ${name}`);
  const result = await db.query<{ value: Row }>(`SELECT purama_ai.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS value`, args);
  return result.rows[0].value;
}
async function asUser<T>(owner: string | null, work: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner ?? '']);
  await db.exec('SET ROLE authenticated');
  try { return await work(); }
  finally { await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub','',false)"); }
}
function qualification(patch: Row = {}): Row {
  return { profile: 'media_affiliate', role: 'commercial', source_url: 'https://publisher.example.invalid/contact',
    country: 'CH', language: 'fr-CH', consent_reference: 'Fixture explicit opt-in receipt with original evidence',
    consent_at: '2020-01-01T00:00:00Z', offer, ...patch };
}
async function qualify(patch: Row = {}, id = prospect, owner: string | null = user): Promise<Row> {
  return asUser(owner, () => call('partner_prospect_qualify', id, JSON.stringify(qualification(patch))));
}
async function prepareOutreach(step = 'outreach'): Promise<Row> {
  const reserved = await call('partner_outreach_reserve', user, prospect, step, token);
  expect(reserved).toMatchObject({ status: 'preparing', claimed: true });
  return call('partner_outreach_save_draft', user, reserved.action_id, token, 'Fixture subject', '<p>Fixture body.</p>');
}
async function sendAndBind(step = 'outreach') {
  if (step !== 'outreach') await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
  const ready = await prepareOutreach(step);
  expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken)).toMatchObject({ status: 'sending', claimed: true });
  expect(await call('partner_outreach_finish', user, ready.action_id, nextToken, 'sent', `provider-${step}`)).toMatchObject({ status: 'sent' });
  const messageId = `<fixture-${step}@example.invalid>`;
  // Trusted fixture for an RFC ID already reconciled from the provider. The
  // dedicated reply tests cover the actual provider-proof binding operation.
  await db.query('UPDATE purama_ai.partner_outreach_dispatches SET rfc_message_id=$1 WHERE id=$2', [messageId, ready.action_id]);
  return { ...ready, messageId };
}
async function enableTerms() {
  await db.query('UPDATE purama_ai.partner_agent_config SET media_contract_terms=$1::jsonb WHERE user_id=$2', [JSON.stringify(terms), user]);
}
async function prepareContract() {
  await db.query("UPDATE purama_ai.partner_prospects SET status='interested',has_replied=true WHERE id=$1", [prospect]);
  const reserved = await call('partner_contract_reserve', user, prospect, token);
  expect(reserved).toMatchObject({ status: 'preparing', claimed: true });
  const path = `${user}/${reserved.contract_id}/${reserved.approval_version}.pdf`;
  const saved = await call('partner_contract_save', user, prospect, token, reserved.approval_version, 'a'.repeat(64), path,
    JSON.stringify({ x: 0.1, y: 0.8, w: 0.4, h: 0.1, page: 0 }));
  expect(saved).toMatchObject({ status: 'pending_approval' });
  return saved;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    INSERT INTO auth.users VALUES ('${user}'),('${other}');
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(readMigration('20260406230000_partner_agent'));
  // This historical migration grants table privileges globally, so it precedes
  // every later reservation/evidence migration that deliberately revokes them.
  await db.exec(readMigration('20260406210000_email_agent'));
  await db.exec("CREATE TYPE purama_ai.app_role AS ENUM ('admin'); CREATE FUNCTION purama_ai.has_role(uuid,purama_ai.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;");
  await db.exec(readMigration('20261110030000_partner_outreach_reservations'));
  await db.exec(readMigration('20261123020000_partner_outreach_schedule'));
  await db.exec(readMigration('20260423110000_docuseal_contracts'));
  await db.exec(readMigration('20261123003000_partner_contract_dispatches'));
  await seedAccounts();
  oldLegacySnapshot = (await call('partner_contract_context', user, prospect)).snapshot as Row;
  await db.exec(readMigration('20261124050000_partner_discovery_evidence'));
  await db.exec(policy);
});
beforeEach(async () => {
  await db.exec("RESET ROLE; TRUNCATE purama_ai.partner_contract_dispatches,purama_ai.contracts,purama_ai.partner_agent_config,purama_ai.partner_prospects,purama_ai.partner_outreach_suppressions,purama_ai.email_agent_config CASCADE");
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  await seedAccounts();
});
afterAll(async () => { await db?.close(); });

describe('media policy — actual SQL migrations', () => {
  it('leaves historical contacts unqualified and blocks first contact without invented permission', async () => {
    expect((await db.query('SELECT outreach_profile,email_permission,contact_qualification FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows)
      .toEqual([{ outreach_profile: 'legacy', email_permission: {}, contact_qualification: {} }]);
    expect(await call('partner_outreach_reserve', user, prospect, 'outreach', token))
      .toMatchObject({ status: 'blocked', reason: 'contact_qualification_required' });
    expect((await db.query('SELECT * FROM purama_ai.partner_outreach_dispatches')).rows).toEqual([]);
  });

  it('uses authenticated ownership for qualification and refuses a foreign account or missing identity', async () => {
    expect(await qualify({}, prospect, null)).toMatchObject({ status: 'blocked', reason: 'authentication_required' });
    expect(await qualify({}, otherProspect, user)).toMatchObject({ status: 'blocked', reason: 'prospect_not_found' });
    expect((await db.query('SELECT email_permission FROM purama_ai.partner_prospects')).rows).toEqual([{ email_permission: {} }, { email_permission: {} }]);
  });

  it('reserves qualification for the authenticated user, not the scheduler or an anonymous caller', async () => {
    for (const role of ['anon', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,'purama_ai.partner_prospect_qualify(uuid,jsonb)','EXECUTE') AS allowed", [role])).rows)
        .toEqual([{ allowed: false }]);
      await db.exec(`SET ROLE ${role}`);
      try { await expect(call('partner_prospect_qualify', prospect, JSON.stringify(qualification()))).rejects.toThrow(/permission denied/); }
      finally { await db.exec('RESET ROLE'); }
    }
  });

  it('prevents ordinary row edits from manufacturing consent or changing a qualified campaign', async () => {
    await asUser(user, async () => {
      await expect(db.query("UPDATE purama_ai.partner_prospects SET email_permission='{\"status\":\"explicit_opt_in\"}'::jsonb WHERE id=$1", [prospect]))
        .rejects.toThrow(/partner_prospect_qualify/);
    });
    expect(await qualify()).toMatchObject({ status: 'qualified' });
    await asUser(user, async () => {
      await expect(db.query("UPDATE purama_ai.partner_prospects SET contact_role='editorial' WHERE id=$1", [prospect]))
        .rejects.toThrow(/partner_prospect_qualify/);
    });
  });

  it('records an explicit qualified contact while preserving its independent discovery evidence', async () => {
    await db.query('UPDATE purama_ai.partner_prospects SET contact_evidence=$1::jsonb WHERE id=$2', [JSON.stringify(evidence), prospect]);
    const result = await qualify();
    expect(result).toMatchObject({ status: 'qualified', prospect: {
      outreach_profile: 'media_affiliate', contact_role: 'commercial', status: 'ready_to_contact',
      contact_evidence: evidence, outreach_offer: offer,
      contact_qualification: { email: 'recipient@example.invalid', country: 'CH', language: 'fr-CH', qualified_by: user },
      email_permission: { status: 'explicit_opt_in', email: 'recipient@example.invalid', reference: qualification().consent_reference },
    } });
    expect((result.prospect as Row).contact_qualification).toHaveProperty('verified_at');
    expect(await prepareOutreach()).toMatchObject({ status: 'ready' });
  });

  it.each([
    [{ profile: 'editorial', role: 'commercial' }, 'campaign_role_mismatch'],
    [{ profile: 'media_affiliate', role: 'editorial' }, 'campaign_role_mismatch'],
    [{ role: 'unknown' }, 'contact_role_required'],
    [{ country: 'France' }, 'qualification_invalid'],
    [{ language: 'not a language' }, 'qualification_invalid'],
    [{ source_url: '' }, 'source_required'],
    [{ source_url: 'https://user:password@publisher.example.invalid/contact' }, 'source_required'],
    [{ source_url: 'https://publisher.example.invalid\\@different.example.invalid' }, 'source_required'],
    [{ source_url: 'https://publisher.example.invalid:70000/contact' }, 'source_required'],
    [{ consent_reference: '' }, 'consent_evidence_required'],
    [{ consent_reference: 'A reference with a forbidden\u000bcontrol' }, 'consent_evidence_required'],
    [{ consent_at: '2999-01-01T00:00:00Z' }, 'invalid_consent_date'],
    [{ consent_at: 'infinity' }, 'invalid_consent_date'],
    [{ consent_at: 20200101 }, 'invalid_consent_date'],
    [{ offer: {} }, 'offer_required'],
    [{ offer: { ...offer, name: { text: 'Not a string' } } }, 'offer_required'],
    [{ offer: { ...offer, name: 'An invalid\nmultiline name' } }, 'offer_required'],
    [{ offer: { ...offer, summary: ['A long enough array is not a summary'] } }, 'offer_required'],
    [{ offer: { ...offer, summary: 'A forbidden\u000bcontrol in the summary' } }, 'offer_required'],
    [{ offer: { ...offer, url: 'http://products.example.invalid/offer' } }, 'offer_required'],
    [{ offer: { ...offer, url: 'https://user:password@products.example.invalid/offer' } }, 'offer_required'],
    [{ offer: { ...offer, url: 'https://products.example.invalid:70000/offer' } }, 'offer_required'],
  ] as const)('rejects incomplete qualification %j without advancing the contact', async (patch, reason) => {
    expect(await qualify(patch)).toMatchObject({ status: 'blocked', reason });
    expect((await db.query('SELECT status,email_permission FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows)
      .toEqual([{ status: 'identified', email_permission: {} }]);
  });

  it('rechecks withdrawn permission after the draft was prepared and before dispatch', async () => {
    await qualify(); const ready = await prepareOutreach();
    expect(await asUser(user, () => call('partner_prospect_qualify', prospect, JSON.stringify({ withdraw_permission: true }))))
      .toMatchObject({ status: 'permission_withdrawn' });
    expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken))
      .toMatchObject({ status: 'blocked', reason: 'provider_opt_in_required' });
    expect((await db.query('SELECT status,dispatch_started_at FROM purama_ai.partner_outreach_dispatches')).rows)
      .toEqual([{ status: 'blocked', dispatch_started_at: null }]);
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',100)")).rows).toEqual([]);
  });

  it('invalidates a draft whose qualified product changed during preparation', async () => {
    await qualify();
    const reserved = await call('partner_outreach_reserve', user, prospect, 'outreach', token);
    await qualify({ offer: { ...offer, name: 'Different product' } });
    expect(await call('partner_outreach_save_draft', user, reserved.action_id, token, 'Old product', '<p>Old draft</p>'))
      .toMatchObject({ status: 'blocked', reason: 'campaign_changed' });
    expect((await db.query('SELECT * FROM purama_ai.partner_emails')).rows).toEqual([]);
  });

  it('invalidates the frozen outgoing payload when qualified language changes before dispatch', async () => {
    await qualify(); const ready = await prepareOutreach();
    await qualify({ language: 'de-CH' });
    expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken))
      .toMatchObject({ status: 'blocked', reason: 'campaign_changed' });
    expect((await db.query('SELECT dispatch_started_at FROM purama_ai.partner_outreach_dispatches')).rows)
      .toEqual([{ dispatch_started_at: null }]);
  });

  it.each([
    'DELETE FROM purama_ai.email_agent_config WHERE user_id=$1',
    'UPDATE purama_ai.email_agent_config SET is_active=false WHERE user_id=$1',
    "UPDATE purama_ai.email_agent_config SET gmail_email='different@example.invalid' WHERE user_id=$1",
    'UPDATE purama_ai.email_agent_config SET gmail_access_token=NULL,gmail_refresh_token=NULL WHERE user_id=$1',
  ])('blocks media first contact without a usable reply mailbox: %s', async change => {
    await qualify(); await db.query(change, [user]);
    expect(await call('partner_outreach_reserve', user, prospect, 'outreach', token))
      .toMatchObject({ status: 'blocked', reason: 'reply_mailbox_required' });
    expect((await db.query('SELECT * FROM purama_ai.partner_outreach_dispatches')).rows).toEqual([]);
  });

  it('rechecks the reply mailbox after the outgoing preview was prepared', async () => {
    await qualify(); const ready = await prepareOutreach();
    await db.query('UPDATE purama_ai.email_agent_config SET is_active=false WHERE user_id=$1', [user]);
    expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken))
      .toMatchObject({ status: 'blocked', reason: 'reply_mailbox_required' });
    expect((await db.query('SELECT dispatch_started_at FROM purama_ai.partner_outreach_dispatches')).rows)
      .toEqual([{ dispatch_started_at: null }]);
  });

  it('requires a verified RFC parent before preparing a follow-up', async () => {
    await qualify(); await sendAndBind();
    await db.query('UPDATE purama_ai.partner_outreach_dispatches SET rfc_message_id=NULL');
    await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    expect(await call('partner_outreach_reserve', user, prospect, 'relance_1', token))
      .toMatchObject({ status: 'blocked', reason: 'followup_thread_required' });
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('followup',100)")).rows).toEqual([]);
    expect((await db.query('SELECT step FROM purama_ai.partner_outreach_dispatches')).rows).toEqual([{ step: 'outreach' }]);
  });

  it('freezes follow-up headers and subject from the exact prior sent thread', async () => {
    await qualify(); const parent = await sendAndBind();
    await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    const followup = await prepareOutreach('relance_1');
    const payload = (await db.query<{ payload: Row }>('SELECT payload FROM purama_ai.partner_outreach_dispatches WHERE id=$1', [followup.action_id])).rows[0].payload;
    expect(payload).toMatchObject({ subject: 'Re: Fixture subject', headers: { 'In-Reply-To': parent.messageId, References: parent.messageId } });
    expect(await call('partner_outreach_begin_send', user, followup.action_id, nextToken))
      .toMatchObject({ status: 'sending', payload });
  });

  it('does not reuse an earlier sender mailbox as the parent after a reconnect', async () => {
    await qualify(); await sendAndBind();
    await db.query("UPDATE purama_ai.partner_agent_config SET sender_email='new-sender@example.invalid' WHERE user_id=$1", [user]);
    await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='new-sender@example.invalid' WHERE user_id=$1", [user]);
    await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    expect(await call('partner_outreach_reserve', user, prospect, 'relance_1', token))
      .toMatchObject({ status: 'blocked', reason: 'followup_thread_required' });
  });

  it('does not reuse a thread addressed to a different now-requalified recipient', async () => {
    await qualify(); await sendAndBind();
    await db.query("UPDATE purama_ai.partner_prospects SET email='changed@example.invalid',next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    await qualify();
    expect(await call('partner_outreach_reserve', user, prospect, 'relance_1', token))
      .toMatchObject({ status: 'blocked', reason: 'followup_thread_required' });
  });

  it('stops the media sequence after two follow-ups even when a caller forces another due date', async () => {
    await qualify(); await sendAndBind(); await sendAndBind('relance_1'); await sendAndBind('relance_2');
    expect((await db.query('SELECT status,relance_count,next_action_at FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows)
      .toEqual([{ status: 'relance_2', relance_count: 2, next_action_at: null }]);
    await db.query("UPDATE purama_ai.partner_prospects SET next_action_at=now()-interval '1 second' WHERE id=$1", [prospect]);
    expect(await call('partner_outreach_reserve', user, prospect, 'relance_3', token))
      .toMatchObject({ status: 'blocked', reason: 'media_followup_limit' });
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('followup',100)")).rows).toEqual([]);
  });

  it.each(['interested', 'contract_sent', 'contract_signed', 'active'])('does not regress %s on a late provider acknowledgement', async status => {
    await qualify(); const ready = await prepareOutreach();
    expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken)).toMatchObject({ status: 'sending' });
    await db.query('UPDATE purama_ai.partner_prospects SET status=$1,next_action_at=NULL WHERE id=$2', [status, prospect]);
    expect(await call('partner_outreach_finish', user, ready.action_id, nextToken, 'sent', 'late-provider-proof')).toMatchObject({ status: 'sent' });
    expect((await db.query('SELECT status,next_action_at FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows)
      .toEqual([{ status, next_action_at: null }]);
  });

  it('requires individual approval for human identity and freezes the expected sender', async () => {
    await qualify();
    await db.query("UPDATE purama_ai.partner_agent_config SET outreach_identity_mode='human_reviewed',require_approval_outreach=false WHERE user_id=$1", [user]);
    expect(await call('partner_outreach_reserve', user, prospect, 'outreach', token))
      .toMatchObject({ status: 'blocked', reason: 'human_review_required' });
    await db.query('UPDATE purama_ai.partner_agent_config SET require_approval_outreach=true WHERE user_id=$1', [user]);
    const pending = await prepareOutreach();
    expect(pending).toMatchObject({ status: 'pending_approval', approval: { from: 'Fixture Sender <sender@example.invalid>' } });
    expect(await call('partner_outreach_begin_send', user, pending.action_id, nextToken)).toMatchObject({ status: 'pending_approval' });
    const approved = await call('partner_outreach_approve', user, pending.email_id, (pending.approval as Row).version);
    expect(approved).toMatchObject({ status: 'ready' });
    expect(await call('partner_outreach_begin_send', user, pending.action_id, nextToken)).toMatchObject({ status: 'sending', claimed: true });
  });

  it('filters unqualified contacts before limiting the scheduler queue', async () => {
    for (let index = 0; index < 15; index++) {
      await db.query("INSERT INTO purama_ai.partner_prospects(user_id,name,email,status,created_at) VALUES ($1,'Unqualified',$2,'ready_to_contact',now()-interval '10 days')",
        [user, `unqualified-${index}@example.invalid`]);
    }
    await qualify();
    expect((await db.query("SELECT * FROM purama_ai.partner_outreach_due('outreach',1)")).rows)
      .toEqual([{ prospect_id: prospect, user_id: user, step: 'outreach' }]);
  });

  it('preserves the exact historical contract snapshot and its 50/10 rates', async () => {
    await enableTerms();
    expect((await call('partner_contract_context', user, prospect)).snapshot).toEqual(oldLegacySnapshot);
    expect(oldLegacySnapshot).toMatchObject({ commission_first_payment: 50, commission_recurring: 10 });
    expect(oldLegacySnapshot).not.toHaveProperty('outreach_profile');
    expect(oldLegacySnapshot).not.toHaveProperty('media_contract_terms');
  });

  it('sets new media agreements to 30/30 and freezes operator clauses verbatim without rewriting old rates', async () => {
    await qualify(); await enableTerms();
    const ctx = await call('partner_contract_context', user, prospect);
    expect(ctx).toEqual({ snapshot: { ...oldLegacySnapshot, outreach_profile: 'media_affiliate', media_terms_version: '20261124',
      commission_first_payment: 30, commission_recurring: 30, eligible_offer: offer, media_contract_terms: terms } });
    expect((await db.query('SELECT commission_first_payment::float,commission_recurring::float FROM purama_ai.partner_agent_config WHERE user_id=$1', [user])).rows)
      .toEqual([{ commission_first_payment: 50, commission_recurring: 10 }]);
    const pending = await prepareContract();
    expect(pending.snapshot).toEqual(ctx.snapshot);
    expect((await db.query('SELECT approved_at,dispatch_started_at FROM purama_ai.partner_contract_dispatches')).rows)
      .toEqual([{ approved_at: null, dispatch_started_at: null }]);
  });

  it('requires every actual clause before preparing a media contract', async () => {
    await qualify();
    expect(await call('partner_contract_context', user, prospect)).toEqual({ reason: 'media_contract_terms_incomplete' });
    await enableTerms();
    await db.query("UPDATE purama_ai.partner_agent_config SET media_contract_terms=media_contract_terms-'payment' WHERE user_id=$1", [user]);
    expect(await call('partner_contract_reserve', user, prospect, token)).toMatchObject({ status: 'blocked', reason: 'media_contract_terms_incomplete' });
    expect((await db.query('SELECT * FROM purama_ai.partner_contract_dispatches')).rows).toEqual([]);
  });

  it.each([
    { ...terms, costs: 'x'.repeat(2001) },
    { ...terms, costs: 'A forbidden\u000bcontrol in this otherwise complete clause.' },
    { ...terms, unlisted_obligation: 'This obligation must not be silently omitted.' },
  ])('rejects unsupported or oversized contract conditions', async (invalid) => {
    await qualify();
    await db.query('UPDATE purama_ai.partner_agent_config SET media_contract_terms=$1::jsonb WHERE user_id=$2', [JSON.stringify(invalid), user]);
    expect(await call('partner_contract_context', user, prospect)).toEqual({ reason: 'media_contract_terms_invalid' });
  });

  it('keeps editorial coverage outside affiliate contracts', async () => {
    await qualify({ profile: 'editorial', role: 'editorial' }); await enableTerms();
    expect(await call('partner_contract_context', user, prospect)).toEqual({ reason: 'editorial_contract_not_applicable' });
    expect(await call('partner_contract_reserve', user, prospect, token)).toMatchObject({ status: 'blocked', reason: 'editorial_contract_not_applicable' });
    expect((await db.query('SELECT * FROM purama_ai.contracts')).rows).toEqual([]);
    const result = (await db.query<{ value: Row }>('SELECT purama_ai.partner_outreach_policy_context($1,$2) AS value', [user, prospect])).rows[0].value;
    expect(result).toMatchObject({ profile: 'editorial', commission_first_payment: 0, commission_recurring: 0 });
  });

  it('rejects approval of an old PDF after a contractual clause changes', async () => {
    await qualify(); await enableTerms(); const pending = await prepareContract();
    await db.query("UPDATE purama_ai.partner_agent_config SET media_contract_terms=jsonb_set(media_contract_terms,'{costs}',$1::jsonb) WHERE user_id=$2",
      [JSON.stringify('A different allocation of costs requiring a new approval.'), user]);
    expect(await call('partner_contract_claim', user, prospect, nextToken, pending.approval_version, pending.pdf_sha256))
      .toMatchObject({ status: 'blocked', reason: 'context_changed' });
    expect((await db.query('SELECT approved_at,dispatch_started_at FROM purama_ai.partner_contract_dispatches')).rows)
      .toEqual([{ approved_at: null, dispatch_started_at: null }]);
  });

  it('reapplies the additive migration without altering evidence, immutable drafts or grants', async () => {
    await qualify(); const ready = await prepareOutreach();
    const before = (await db.query('SELECT * FROM purama_ai.partner_outreach_dispatches WHERE id=$1', [ready.action_id])).rows;
    const prospectBefore = (await db.query('SELECT * FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows;
    await db.exec(policy);
    expect((await db.query('SELECT * FROM purama_ai.partner_outreach_dispatches WHERE id=$1', [ready.action_id])).rows).toEqual(before);
    expect((await db.query('SELECT * FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows).toEqual(prospectBefore);
    expect((await db.query("SELECT has_function_privilege('authenticated','purama_ai.partner_outreach_policy_context(uuid,uuid)','EXECUTE') AS allowed")).rows)
      .toEqual([{ allowed: false }]);
    expect(await call('partner_outreach_begin_send', user, ready.action_id, nextToken)).toMatchObject({ status: 'sending', claimed: true });
  });
});

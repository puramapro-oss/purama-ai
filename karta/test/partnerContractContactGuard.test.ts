import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Execute the additive migration and the real contract state machine. No
// DocuSeal, mailbox, external contact, signature or production DB is used.
type Row = Record<string, unknown>;
const migration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const guard = migration('20261124050300_partner_contract_contact_guard');
const owner = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const prospect = '00000000-0000-4000-8000-000000000011';
const token = '00000000-0000-4000-8000-000000000021';
const sendingToken = '00000000-0000-4000-8000-000000000022';
const offer = { name: 'Fixture offer', url: 'https://products.example.invalid/offer', summary: 'Fixture factual offer used only by isolated tests.' };
const terms = Object.fromEntries([
  'parties_identity', 'products_and_countries', 'attribution', 'recurrence', 'payment',
  'refunds', 'duration_termination', 'content_rights', 'costs', 'disputes',
].map(key => [key, `Fixture actual condition for ${key}; never an operational agreement.`]));
const qualification = { profile: 'media_affiliate', role: 'commercial',
  source_url: 'https://publisher.example.invalid/contact', country: 'FR', language: 'fr',
  consent_reference: 'Fixture consent evidenced by an isolated original receipt.', consent_at: '2020-01-01T00:00:00Z', offer };
const signatures: Record<string, number> = {
  partner_prospect_qualify: 2, partner_contract_context: 2, partner_contract_result: 2,
  partner_contract_reserve: 3, partner_contract_save: 7, partner_contract_claim: 5,
  partner_contract_begin_submission: 3, partner_contract_finish: 8,
};
let db: PGlite;

async function call(name: string, ...args: unknown[]): Promise<Row> {
  if (signatures[name] !== args.length) throw new Error(`Unexpected fixture RPC ${name}`);
  return (await db.query<{ value: Row }>(`SELECT purama_ai.${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) AS value`, args)).rows[0].value;
}
async function asOwner<T>(work: () => Promise<T>) {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
  await db.exec('SET ROLE authenticated');
  try { return await work(); }
  finally { await db.exec('RESET ROLE'); await db.query("SELECT set_config('request.jwt.claim.sub','',false)"); }
}
async function qualify() {
  expect(await asOwner(() => call('partner_prospect_qualify', prospect, JSON.stringify(qualification))))
    .toMatchObject({ status: 'qualified' });
}
async function withdraw() {
  expect(await asOwner(() => call('partner_prospect_qualify', prospect, JSON.stringify({ withdraw_permission: true }))))
    .toMatchObject({ status: 'permission_withdrawn' });
}
async function reserve() {
  const result = await call('partner_contract_reserve', owner, prospect, token);
  expect(result).toMatchObject({ status: 'preparing', claimed: true });
  return result;
}
async function save(reserved: Row) {
  return call('partner_contract_save', owner, prospect, token, reserved.approval_version,
    'a'.repeat(64), `${owner}/${reserved.contract_id}/${reserved.approval_version}.pdf`,
    JSON.stringify({ x: 30, y: 700, w: 200, h: 60, page: 1 }));
}
async function pending() {
  const result = await save(await reserve());
  expect(result).toMatchObject({ status: 'pending_approval' });
  return result;
}
async function claim(prepared: Row) {
  return call('partner_contract_claim', owner, prospect, sendingToken, prepared.approval_version, prepared.pdf_sha256);
}
async function noInvitation() {
  expect((await db.query<{ submission_started_at: unknown }>('SELECT submission_started_at FROM purama_ai.partner_contract_dispatches')).rows
    .every(row => row.submission_started_at === null)).toBe(true);
  expect((await db.query("SELECT id FROM purama_ai.contracts WHERE status <> 'draft'")).rows).toEqual([]);
  expect((await db.query("SELECT id FROM purama_ai.contract_events WHERE event_type='sent'")).rows).toEqual([]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO anon,authenticated,service_role;
    INSERT INTO auth.users VALUES ('${owner}'),('${other}');
    CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);`);
  await db.exec(migration('20260406230000_partner_agent'));
  await db.exec(migration('20260406210000_email_agent'));
  await db.exec("CREATE TYPE purama_ai.app_role AS ENUM ('admin'); CREATE FUNCTION purama_ai.has_role(uuid,purama_ai.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;");
  await db.exec(migration('20261110030000_partner_outreach_reservations'));
  await db.exec(migration('20261123020000_partner_outreach_schedule'));
  await db.exec(migration('20260423110000_docuseal_contracts'));
  await db.exec(migration('20261123003000_partner_contract_dispatches'));
  await db.exec(migration('20261124050000_partner_discovery_evidence'));
  await db.exec(migration('20261124050100_partner_media_policy'));
  await db.exec(guard);
});
beforeEach(async () => {
  await db.exec('RESET ROLE; TRUNCATE purama_ai.partner_contract_dispatches,purama_ai.contracts,purama_ai.partner_agent_config,purama_ai.partner_prospects,purama_ai.partner_outreach_suppressions CASCADE');
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  await db.query(`INSERT INTO purama_ai.partner_agent_config(user_id,is_active,sender_name,sender_email,company_name,commission_first_payment,commission_recurring,media_contract_terms)
    VALUES($1,true,'Fixture Sender','sender@example.invalid','Fixture Company',9,3,$2::jsonb),
      ($3,true,'Other Sender','other@example.invalid','Other Company',9,3,$2::jsonb)`, [owner, JSON.stringify(terms), other]);
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status,has_replied)
    VALUES($1,$2,'Fixture Recipient','recipient@example.invalid','interested',true)`, [prospect, owner]);
});
afterAll(async () => { await db?.close(); });

describe('contract contact mandate at every sending boundary', () => {
  it('keeps a qualified media agreement at 30/30 and preserves the historical snapshot shape', async () => {
    const legacy = await call('partner_contract_context', owner, prospect);
    expect(legacy.snapshot).toMatchObject({ commission_first_payment: 9, commission_recurring: 3 });
    expect(legacy.snapshot).not.toHaveProperty('outreach_profile');
    await qualify();
    const media = await call('partner_contract_context', owner, prospect);
    expect(media.snapshot).toMatchObject({ outreach_profile: 'media_affiliate', commission_first_payment: 30, commission_recurring: 30 });
    expect(Object.keys(media.snapshot as Row).sort()).toEqual([...Object.keys(legacy.snapshot as Row),
      'outreach_profile', 'media_terms_version', 'eligible_offer', 'media_contract_terms'].sort());
    expect(await claim(await pending())).toMatchObject({ status: 'sending', claimed: true });
    expect(await call('partner_contract_begin_submission', owner, prospect, sendingToken)).toMatchObject({ status: 'sending', claimed: true });
  });

  it.each(['reserve', 'save', 'claim', 'submission'] as const)('blocks a withdrawal before %s without sending an invitation', async stage => {
    await qualify();
    let prepared: Row | undefined;
    if (stage === 'save') prepared = await reserve();
    if (stage === 'claim' || stage === 'submission') prepared = await pending();
    if (stage === 'submission') expect(await claim(prepared!)).toMatchObject({ status: 'sending', claimed: true });
    await withdraw();
    const result = stage === 'reserve' ? await call('partner_contract_reserve', owner, prospect, token)
      : stage === 'save' ? await save(prepared!)
        : stage === 'claim' ? await claim(prepared!)
          : await call('partner_contract_begin_submission', owner, prospect, sendingToken);
    expect(result).toMatchObject({ status: 'blocked', reason: 'provider_opt_in_required' });
    await noInvitation();
  });

  it.each(['reserve', 'claim', 'submission'] as const)('requires a new qualification after the recipient email changes before %s', async stage => {
    await qualify();
    const prepared = stage === 'reserve' ? undefined : await pending();
    if (stage === 'submission') expect(await claim(prepared!)).toMatchObject({ claimed: true });
    await asOwner(() => db.query('UPDATE purama_ai.partner_prospects SET email=$1 WHERE id=$2', ['changed@example.invalid', prospect]));
    const result = stage === 'reserve' ? await call('partner_contract_reserve', owner, prospect, token)
      : stage === 'claim' ? await claim(prepared!)
        : await call('partner_contract_begin_submission', owner, prospect, sendingToken);
    expect(result).toMatchObject({ status: 'blocked', reason: 'contact_qualification_required' });
    await noInvitation();
  });

  it.each(['claim', 'submission'] as const)('preserves the account-wide suppression before %s', async stage => {
    await qualify(); const prepared = await pending();
    if (stage === 'submission') expect(await claim(prepared)).toMatchObject({ claimed: true });
    await db.query(`INSERT INTO purama_ai.partner_outreach_suppressions(user_id,email_normalized)
      VALUES($1,'recipient@example.invalid')`, [owner]);
    expect(stage === 'claim' ? await claim(prepared) : await call('partner_contract_begin_submission', owner, prospect, sendingToken))
      .toMatchObject({ status: 'blocked', reason: 'contact_suppressed' });
    await noInvitation();
  });

  it.each([
    ['contact_qualification', 'qualified_by', other, 'contact_qualification_required'],
    ['contact_qualification', 'email', 'other@example.invalid', 'contact_qualification_required'],
    ['contact_qualification', 'source_url', '', 'contact_qualification_required'],
    ['contact_qualification', 'source_url', 'https://user:secret@example.invalid/contact', 'contact_qualification_required'],
    ['email_permission', 'email', 'other@example.invalid', 'provider_opt_in_required'],
    ['email_permission', 'status', 'unknown', 'provider_opt_in_required'],
    ['email_permission', 'reference', '', 'provider_opt_in_required'],
  ] as const)('refuses inconsistent trusted evidence %s.%s', async (column, key, value, reason) => {
    await qualify();
    // Postgres fixture mutation simulates an incomplete import; ordinary owner
    // writes are already prohibited by the real qualification trigger.
    await db.query(`UPDATE purama_ai.partner_prospects SET ${column}=jsonb_set(${column},$1::text[],$2::jsonb) WHERE id=$3`,
      [[key], JSON.stringify(value), prospect]);
    expect(await call('partner_contract_reserve', owner, prospect, token)).toMatchObject({ status: 'blocked', reason });
    await noInvitation();
  });

  it('allows a fresh explicit qualification but requires a new PDF approval after a blocked claim', async () => {
    await qualify(); const old = await pending(); await withdraw();
    expect(await claim(old)).toMatchObject({ status: 'blocked' });
    await qualify(); const renewed = await pending();
    expect(renewed.contract_id).toBe(old.contract_id);
    expect(renewed.approval_version).not.toBe(old.approval_version);
    expect(await claim(old)).toMatchObject({ status: 'blocked', reason: 'stale_approval' });
    expect(await claim(renewed)).toMatchObject({ status: 'sending', claimed: true });
  });

  it('keeps a signed contract and its preview receipt readable after withdrawal', async () => {
    await qualify(); const prepared = await pending();
    expect(await claim(prepared)).toMatchObject({ claimed: true });
    expect(await call('partner_contract_begin_submission', owner, prospect, sendingToken)).toMatchObject({ claimed: true });
    expect(await call('partner_contract_finish', owner, prospect, sendingToken, 'sent', 42, 17, 31, 'https://signature.example.invalid/receipt'))
      .toMatchObject({ status: 'sent' });
    await db.query("UPDATE purama_ai.contracts SET status='signed',signed_at=now() WHERE id=$1", [prepared.contract_id]);
    const before = await call('partner_contract_result', owner, prospect);
    const signed = (await db.query('SELECT * FROM purama_ai.contracts WHERE id=$1', [prepared.contract_id])).rows;
    await withdraw();
    expect(await call('partner_contract_result', owner, prospect)).toEqual(before);
    expect((await db.query('SELECT * FROM purama_ai.contracts WHERE id=$1', [prepared.contract_id])).rows).toEqual(signed);
    expect((await db.query('SELECT status,contract_signed_at FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows[0])
      .toMatchObject({ status: 'contract_signed', contract_signed_at: expect.any(Date) });
  });

  it('retains service-only execution, account isolation and idempotent migration replay', async () => {
    await qualify(); const prepared = await pending();
    expect(await call('partner_contract_context', other, prospect)).toEqual({ reason: 'prospect_not_found' });
    for (const role of ['anon', 'authenticated']) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,'purama_ai.partner_contract_context(uuid,uuid)','EXECUTE') AS allowed", [role])).rows)
        .toEqual([{ allowed: false }]);
    }
    expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege('service_role','purama_ai.partner_contract_context(uuid,uuid)','EXECUTE') AS allowed")).rows)
      .toEqual([{ allowed: true }]);
    await db.exec(guard);
    expect(await call('partner_contract_result', owner, prospect)).toEqual(prepared);
    expect(await claim(prepared)).toMatchObject({ status: 'sending', claimed: true });
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Actual SQL, authenticated RPCs and the established contract lifecycle. The
// signature/provider records below are explicit fixtures, never real signers.
type Row = Record<string, unknown>;
const readMigration = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const user = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const prospect = '00000000-0000-4000-8000-000000000011';
const otherProspect = '00000000-0000-4000-8000-000000000012';
const token = '00000000-0000-4000-8000-000000000021';
const sendToken = '00000000-0000-4000-8000-000000000022';
const offer = { name: 'Fixture media offer', url: 'https://products.example.invalid/offer',
  summary: 'An explicit fictional offer for admission tests only.' };
const termKeys = ['parties_identity', 'products_and_countries', 'attribution', 'recurrence', 'payment',
  'refunds', 'duration_termination', 'content_rights', 'costs', 'disputes'];
const terms = Object.fromEntries(termKeys.map(key => [key, `Fixture clause ${key}; not a commercial decision.`]));
const missing = ['beneficiary_identity', 'tenant_mapping', 'catalog_binding', 'executable_policy',
  'verified_attribution', 'provider_settlement', 'one_runtime', 'payout_runtime'];
let db: PGlite;
let contract: Row;

const signatures: Record<string, number> = {
  partner_prospect_qualify: 2, partner_contract_reserve: 3, partner_contract_save: 7,
  partner_contract_claim: 5, partner_contract_begin_submission: 3, partner_contract_finish: 8,
  partner_affiliation_admission_prepare: 1, partner_affiliation_candidates: 1,
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
const prepare = (id = prospect, owner: string | null = user) =>
  asUser(owner, () => call('partner_affiliation_admission_prepare', id));
const candidates = (page: number | null = 0, owner: string | null = user) =>
  asUser(owner, () => call('partner_affiliation_candidates', page));
const admissionCount = async () => (await db.query<{ count: number }>(
  'SELECT count(*)::integer AS count FROM purama_ai.partner_affiliation_admissions')).rows[0].count;
async function seedSignedContract(): Promise<Row> {
  await db.query(`INSERT INTO purama_ai.partner_agent_config(user_id,is_active,sender_name,sender_email,company_name,media_contract_terms)
    VALUES ($1,true,'Fixture Sender','sender@example.invalid','Fixture Company',$3::jsonb),
      ($2,true,'Other Sender','other@example.invalid','Other Company','{}'::jsonb)`, [user, other, JSON.stringify(terms)]);
  await db.query(`INSERT INTO purama_ai.partner_prospects(id,user_id,name,email,status)
    VALUES ($1,$2,'Fixture Recipient','recipient@example.invalid','identified'),
      ($3,$4,'Other Recipient','other-recipient@example.invalid','identified')`, [prospect, user, otherProspect, other]);
  await asUser(user, async () => {
    expect(await call('partner_prospect_qualify', prospect, JSON.stringify({
      profile: 'media_affiliate', role: 'commercial', source_url: 'https://publisher.example.invalid/contact',
      country: 'FR', language: 'fr', consent_reference: 'Fixture explicit consent, not a real mandate',
      consent_at: '2020-01-01T00:00:00Z', offer,
    }))).toMatchObject({ status: 'qualified' });
  });
  await db.query("UPDATE purama_ai.partner_prospects SET status='interested',has_replied=true WHERE id=$1", [prospect]);
  const reserved = await call('partner_contract_reserve', user, prospect, token);
  expect(reserved).toMatchObject({ status: 'preparing', claimed: true });
  const saved = await call('partner_contract_save', user, prospect, token, reserved.approval_version, 'a'.repeat(64),
    `${user}/${reserved.contract_id}/${reserved.approval_version}.pdf`, JSON.stringify({ x: 0.1, y: 0.8, w: 0.4, h: 0.1, page: 0 }));
  expect(saved.status).toBe('pending_approval');
  expect(await call('partner_contract_claim', user, prospect, sendToken, saved.approval_version, saved.pdf_sha256))
    .toMatchObject({ status: 'sending', claimed: true });
  expect(await call('partner_contract_begin_submission', user, prospect, sendToken)).toMatchObject({ claimed: true });
  expect(await call('partner_contract_finish', user, prospect, sendToken, 'sent', 123, 456, 789, 'https://sign.example.invalid/fixture'))
    .toMatchObject({ status: 'sent' });
  // Fixture counterpart of the authenticated DocuSeal webhook. No external call.
  await db.query("UPDATE purama_ai.contract_signers SET signed=true,signed_at=clock_timestamp(),ip_address='127.0.0.1',user_agent='fixture-private' WHERE contract_id=$1", [saved.contract_id]);
  await db.query("UPDATE purama_ai.contracts SET status='signed',signed_at=clock_timestamp() WHERE id=$1", [saved.contract_id]);
  await db.query("INSERT INTO purama_ai.contract_events(contract_id,event_type,payload) VALUES($1,'signed','{}'::jsonb)", [saved.contract_id]);
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
  for (const name of ['20260406230000_partner_agent', '20260406210000_email_agent']) await db.exec(readMigration(name));
  await db.exec("CREATE TYPE purama_ai.app_role AS ENUM ('admin'); CREATE FUNCTION purama_ai.has_role(uuid,purama_ai.app_role) RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;");
  for (const name of ['20261110030000_partner_outreach_reservations', '20261123020000_partner_outreach_schedule',
    '20260423110000_docuseal_contracts', '20261123003000_partner_contract_dispatches',
    '20261124050000_partner_discovery_evidence', '20261124050100_partner_media_policy',
    '20261124050200_partner_reply_evidence', '20261124050300_partner_contract_contact_guard',
    '20261124050500_partner_affiliation_admission']) await db.exec(readMigration(name));
});

describe('signed media candidate projection — actual SQL', () => {
  it('lists only the owned minimal projection without preparing or activating a dossier', async () => {
    const result = await candidates();
    expect(result).toMatchObject({ status: 'ready', user_id: user, has_more: false,
      candidates: [{ id: prospect, user_id: user, name: 'Fixture Recipient', contract_signed_at: expect.any(String) }] });
    expect(Object.keys((result.candidates as Row[])[0]).sort()).toEqual(['contract_signed_at','id','name','user_id']);
    expect(JSON.stringify(result)).not.toContain('snapshot');
    expect(await admissionCount()).toBe(0);
    expect((await db.query('SELECT * FROM purama_ai.partner_active')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM purama_ai.partner_commissions')).rows).toEqual([]);
    const defaultPage = await asUser(user, () => db.query<{ value: Row }>('SELECT purama_ai.partner_affiliation_candidates() AS value'));
    expect(defaultPage.rows[0].value).toEqual(result);
  });

  it('keeps an already signed media agreement visible and preparable after withdrawal and rejection', async () => {
    const prepared = await prepare();
    expect(await asUser(user, () => call('partner_prospect_qualify', prospect, JSON.stringify({ withdraw_permission: true }))))
      .toMatchObject({ status: 'permission_withdrawn' });
    await db.query("UPDATE purama_ai.partner_prospects SET status='rejected',name='Changed display' WHERE id=$1", [prospect]);
    expect(await candidates()).toMatchObject({ status: 'ready', candidates: [{ id: prospect, name: 'Fixture Recipient' }], has_more: false });
    expect(await prepare()).toEqual({ ...prepared, reused: true });
  });

  it.each(['legacy','editorial'])('keeps the signed media snapshot when the current profile becomes %s', async profile => {
    expect(await asUser(user, () => call('partner_prospect_qualify', prospect, JSON.stringify({
      profile, role: profile === 'editorial' ? 'editorial' : 'commercial', source_url: 'https://publisher.example.invalid/contact',
      country: 'FR', language: 'fr', consent_reference: 'Updated fixture contact qualification, not a new agreement',
      consent_at: '2020-01-01T00:00:00Z', offer,
    })))).toMatchObject({ status: 'qualified' });
    await db.query("UPDATE purama_ai.partner_prospects SET status='inactive',contract_signed_at=NULL WHERE id=$1", [prospect]);
    expect(await candidates()).toMatchObject({ status: 'ready', candidates: [{ id: prospect }], has_more: false });
    expect(await prepare()).toMatchObject({ status: 'prepared', admission: {
      snapshot: { contract_snapshot: { outreach_profile: 'media_affiliate', commission_recurring: 30 } },
    } });
  });

  it('does not disclose another owner’s candidate or accept a missing identity', async () => {
    expect(await candidates(0, other)).toEqual({ status: 'ready', user_id: other, candidates: [], has_more: false });
    expect(await candidates(0, null)).toEqual({ status: 'blocked', reason: 'authentication_required' });
  });

  it.each([
    "UPDATE purama_ai.partner_contract_dispatches SET user_id=$2,approved_by=$2 WHERE contract_id=$1",
    "UPDATE purama_ai.contracts SET user_id=$2 WHERE id=$1",
    "UPDATE purama_ai.partner_prospects SET user_id=$2 WHERE id=(SELECT prospect_id FROM purama_ai.partner_contract_dispatches WHERE contract_id=$1)",
  ])('requires matching ownership across all three source records: %s', async change => {
    await db.query(change, [contract.contract_id, other]);
    expect(await candidates()).toEqual({ status: 'ready', user_id: user, candidates: [], has_more: false });
    expect(await candidates(0, other)).toEqual({ status: 'ready', user_id: other, candidates: [], has_more: false });
  });

  it.each([
    "UPDATE purama_ai.contracts SET status='sent' WHERE id=$1",
    "UPDATE purama_ai.contracts SET app_slug='another-app' WHERE id=$1",
    "UPDATE purama_ai.contracts SET template_slug='another-template' WHERE id=$1",
    "UPDATE purama_ai.contracts SET cancelled_at=clock_timestamp() WHERE id=$1",
    "UPDATE purama_ai.contracts SET signed_at=NULL WHERE id=$1",
    "UPDATE purama_ai.contracts SET signed_at='infinity' WHERE id=$1",
    "UPDATE purama_ai.contracts SET signed_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    "UPDATE purama_ai.partner_contract_dispatches SET snapshot=jsonb_set(snapshot,'{outreach_profile}','\"legacy\"'::jsonb) WHERE contract_id=$1",
  ])('does not list an invalid or non-media signed source: %s', async change => {
    await db.query(change, [contract.contract_id]);
    expect(await candidates()).toEqual({ status: 'ready', user_id: user, candidates: [], has_more: false });
  });

  it('paginates 25 plus one with stable tie order and no unbounded source projection', async () => {
    const copyIds: string[] = [];
    // These rows only exercise the candidate list. The full admission function
    // still requires its separately tested signer and approval evidence.
    for (let index = 1; index <= 26; index++) {
      const suffix = String(index).padStart(12, '0');
      const copyProspect = `10000000-0000-4000-8000-${suffix}`;
      const copyContract = `20000000-0000-4000-8000-${suffix}`;
      copyIds.push(copyProspect);
      await db.query("INSERT INTO purama_ai.partner_prospects(id,user_id,name,status) VALUES($1,$2,'Current display','inactive')", [copyProspect, user]);
      await db.query("INSERT INTO purama_ai.contracts(id,user_id,app_slug,template_slug,status,signed_at) VALUES($1,$2,'purama_ai','partner-generated','signed','2000-01-01T00:00:00Z')", [copyContract, user]);
      await db.query(`INSERT INTO purama_ai.partner_contract_dispatches(contract_id,user_id,prospect_id,status,claim_token,
        approval_version,snapshot,storage_path,pdf_sha256,signature_area,approved_at,approved_by)
        SELECT $1,user_id,$2,status,claim_token,approval_version,snapshot,storage_path,pdf_sha256,signature_area,approved_at,approved_by
        FROM purama_ai.partner_contract_dispatches WHERE contract_id=$3`, [copyContract, copyProspect, contract.contract_id]);
    }
    const first = await candidates(), second = await candidates(1);
    expect(first.has_more).toBe(true); expect(second.has_more).toBe(false);
    expect((first.candidates as Row[]).map(row => row.id)).toEqual([prospect, ...copyIds.slice(0, 24)]);
    expect((second.candidates as Row[]).map(row => row.id)).toEqual(copyIds.slice(24));
    expect(await candidates(2)).toEqual({ status: 'ready', user_id: user, candidates: [], has_more: false });
    expect(await admissionCount()).toBe(0);
  });

  it.each([null,-1,100001])('rejects invalid page %s', async page => {
    expect(await candidates(page)).toEqual({ status: 'blocked', reason: 'invalid_page' });
  });

  it('restricts candidate execution to authenticated owners', async () => {
    for (const [role, allowed] of [['authenticated',true], ['anon',false], ['service_role',false]] as const) {
      expect((await db.query<{ allowed: boolean }>(
        "SELECT has_function_privilege($1,'purama_ai.partner_affiliation_candidates(integer)','EXECUTE') AS allowed", [role])).rows)
        .toEqual([{ allowed }]);
    }
  });
});
beforeEach(async () => {
  await db.exec('RESET ROLE; TRUNCATE purama_ai.partner_affiliation_admissions,purama_ai.partner_contract_dispatches,purama_ai.contracts,purama_ai.partner_agent_config,purama_ai.partner_prospects,purama_ai.partner_outreach_suppressions CASCADE');
  await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
  contract = await seedSignedContract();
});
afterAll(async () => { await db?.close(); });

describe('signed media affiliation admission — actual SQL', () => {
  it('derives a private immutable dossier from the exact approved and signed contract', async () => {
    const result = await prepare();
    expect(result).toMatchObject({ status: 'prepared', reused: false, integration: {
      status: 'requirements_missing', missing, activation_allowed: false, payment_allowed: false,
      one_revision: 'a5fed2edaaa2332c0e9aba3321d9ee32cf89a17e',
    }, admission: { user_id: user, prospect_id: prospect, contract_id: contract.contract_id, version: 1,
      snapshot: { schema_version: 1, source: 'purama_ai_signed_media_contract', owner_id: user,
        contract_snapshot: { commission_first_payment: 30, commission_recurring: 30, eligible_offer: offer, media_contract_terms: terms },
        document: { approval_version: contract.approval_version, approved_pdf_sha256: 'a'.repeat(64), approved_by: user },
        signature: { provider: 'docuseal', submission_id: 123, template_id: 789,
          signers: [{ name: 'Fixture Recipient', email: 'recipient@example.invalid', role: 'business_partner', provider_submitter_id: 456 }] },
        beneficiary_id: null, financial_authority: 'none',
      } } });
    const admission = result.admission as Row;
    expect(admission.id).toEqual(expect.any(String));
    expect(admission.created_at).toEqual(expect.any(String));
    expect((admission.snapshot as Row).evidence).toMatchObject({
      source: 'authenticated_contract_hub', approval_event_id: expect.any(String),
      dispatch_event_id: expect.any(String), signature_event_id: expect.any(String),
    });
    expect(JSON.stringify(admission)).not.toContain('fixture-private');
    expect(JSON.stringify(admission)).not.toContain('127.0.0.1');
    expect(await admissionCount()).toBe(1);
    expect((await db.query('SELECT * FROM purama_ai.partner_active')).rows).toEqual([]);
    expect((await db.query('SELECT * FROM purama_ai.partner_commissions')).rows).toEqual([]);
    expect((await db.query('SELECT status FROM purama_ai.partner_prospects WHERE id=$1', [prospect])).rows)
      .toEqual([{ status: 'contract_signed' }]);
  });

  it('returns the same complete dossier on repeated preparation without new rows', async () => {
    const first = await prepare();
    for (let index = 0; index < 8; index++) expect(await prepare()).toEqual({ ...first, reused: true });
    expect(await admissionCount()).toBe(1);
  });

  it('keeps the first complete audit event when a provider webhook is replayed', async () => {
    const first = await prepare();
    await db.query('UPDATE purama_ai.contract_signers SET signed_at=clock_timestamp() WHERE contract_id=$1', [contract.contract_id]);
    await db.query('UPDATE purama_ai.contracts SET signed_at=clock_timestamp() WHERE id=$1', [contract.contract_id]);
    await db.query("INSERT INTO purama_ai.contract_events(contract_id,event_type,payload) VALUES($1,'signed','{}'::jsonb)", [contract.contract_id]);
    expect(await prepare()).toEqual({ ...first, reused: true });
  });

  it('preserves signed terms when current account settings, offer or contact display change', async () => {
    const first = await prepare();
    await db.query("UPDATE purama_ai.partner_agent_config SET commission_first_payment=50,commission_recurring=10,media_contract_terms='{}'::jsonb WHERE user_id=$1", [user]);
    await db.query("UPDATE purama_ai.partner_prospects SET name='New display name',outreach_offer='{}'::jsonb WHERE id=$1", [prospect]);
    expect(await prepare()).toEqual({ ...first, reused: true });
  });

  it('does not reinterpret the historical signing invitation expiry as the commercial contract duration', async () => {
    await db.query("UPDATE purama_ai.contracts SET expires_at=now()-interval '1 day' WHERE id=$1", [contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'prepared', integration: { missing: expect.arrayContaining(['executable_policy']) } });
  });

  it('rejects a missing identity and does not disclose a foreign prospect or prepared dossier', async () => {
    expect(await prepare(prospect, null)).toMatchObject({ status: 'blocked', reason: 'authentication_required' });
    expect(await prepare(otherProspect)).toMatchObject({ status: 'blocked', reason: 'prospect_not_found' });
    await prepare();
    expect(await prepare(prospect, other)).toMatchObject({ status: 'blocked', reason: 'prospect_not_found' });
    expect(await asUser(other, () => db.query('SELECT * FROM purama_ai.partner_affiliation_admissions')))
      .toMatchObject({ rows: [] });
    expect(await asUser(user, () => db.query('SELECT id FROM purama_ai.partner_affiliation_admissions')))
      .toMatchObject({ rows: [{ id: expect.any(String) }] });
  });

  it('does not grant anonymous or scheduler execution, or direct table mutation to the owner', async () => {
    for (const role of ['anon', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_function_privilege($1,'purama_ai.partner_affiliation_admission_prepare(uuid)','EXECUTE') AS allowed", [role])).rows)
        .toEqual([{ allowed: false }]);
    }
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect((await db.query<{ allowed: boolean }>("SELECT has_table_privilege('authenticated','purama_ai.partner_affiliation_admissions',$1) AS allowed", [privilege])).rows)
        .toEqual([{ allowed: false }]);
    }
    await prepare();
    await asUser(user, async () => {
      await expect(db.exec("UPDATE purama_ai.partner_affiliation_admissions SET snapshot='{}'::jsonb")).rejects.toThrow(/permission denied/);
      await expect(db.exec('DELETE FROM purama_ai.partner_affiliation_admissions')).rejects.toThrow(/permission denied/);
      await expect(db.query("INSERT INTO purama_ai.partner_affiliation_admissions(user_id,prospect_id,contract_id,snapshot) VALUES($1,$2,$3,'{}'::jsonb)",
        [user, prospect, contract.contract_id])).rejects.toThrow(/permission denied/);
    });
  });

  it('refuses ordinary owner edits to manufacture signature or provider audit evidence', async () => {
    await db.query("UPDATE purama_ai.contract_signers SET signed=false,signed_at=NULL WHERE contract_id=$1", [contract.contract_id]);
    await asUser(user, async () => {
      expect((await db.query("UPDATE purama_ai.contract_signers SET signed=true,signed_at=now() WHERE contract_id=$1 RETURNING id", [contract.contract_id])).rows).toEqual([]);
      await expect(db.query("INSERT INTO purama_ai.contract_events(contract_id,event_type,payload) VALUES($1,'signed','{}'::jsonb)", [contract.contract_id]))
        .rejects.toThrow(/row-level security/);
    });
    expect(await prepare()).toMatchObject({ status: 'blocked', reason: 'signature_evidence_required' });
    expect(await admissionCount()).toBe(0);
  });

  it.each(['sent', 'opened', 'declined', 'cancelled', 'expired'])('does not admit a contract whose hub status is %s', async status => {
    await db.query('UPDATE purama_ai.contracts SET status=$1::purama_ai.contract_status WHERE id=$2', [status, contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'blocked', reason: 'signed_contract_required' });
    expect(await admissionCount()).toBe(0);
  });

  it.each([
    ["UPDATE purama_ai.contracts SET signed_at=NULL WHERE id=$1", 'signed_contract_required'],
    ["UPDATE purama_ai.contracts SET signed_at='infinity' WHERE id=$1", 'signed_contract_required'],
    ["UPDATE purama_ai.contracts SET signed_at=now()+interval '1 day' WHERE id=$1", 'signed_contract_required'],
    ["UPDATE purama_ai.contracts SET cancelled_at=now() WHERE id=$1", 'signed_contract_required'],
    ["UPDATE purama_ai.contracts SET app_slug='other-app' WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET template_slug='other-template' WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET pdf_storage_path='wrong/path.pdf' WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET metadata=jsonb_set(metadata,'{pdf_sha256}',to_jsonb(repeat('b',64))) WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET metadata=metadata-'approval_version' WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET metadata=metadata-'partner_prospect_id' WHERE id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contracts SET docuseal_submission_id=999 WHERE id=$1", 'dispatch_evidence_required'],
    ["UPDATE purama_ai.partner_contract_dispatches SET status='unknown' WHERE contract_id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.partner_contract_dispatches SET submission_started_at=NULL WHERE contract_id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contract_signers SET email='other@example.invalid' WHERE contract_id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contract_signers SET name='Different party' WHERE contract_id=$1", 'contract_source_mismatch'],
    ["UPDATE purama_ai.contract_signers SET docuseal_submitter_id=999 WHERE contract_id=$1", 'dispatch_evidence_required'],
    ["UPDATE purama_ai.contract_signers SET signed=false WHERE contract_id=$1", 'signature_evidence_required'],
    ["UPDATE purama_ai.contract_signers SET signed_at=NULL WHERE contract_id=$1", 'signature_evidence_required'],
    ["UPDATE purama_ai.contract_signers SET declined_at=now() WHERE contract_id=$1", 'signature_evidence_required'],
    ["DELETE FROM purama_ai.contract_events WHERE contract_id=$1 AND payload->>'action'='approved'", 'approval_evidence_required'],
    ["DELETE FROM purama_ai.contract_events WHERE contract_id=$1 AND event_type='sent'", 'dispatch_evidence_required'],
    ["DELETE FROM purama_ai.contract_events WHERE contract_id=$1 AND event_type='signed'", 'signature_evidence_required'],
    ["UPDATE purama_ai.contract_events SET payload='{\"partial\":true}'::jsonb WHERE contract_id=$1 AND event_type='signed'", 'signature_evidence_required'],
    ["UPDATE purama_ai.contract_events SET actor_type='user' WHERE contract_id=$1 AND event_type='signed'", 'signature_evidence_required'],
    ["UPDATE purama_ai.contract_events SET created_at=now()+interval '1 day' WHERE contract_id=$1 AND event_type='signed'", 'signature_evidence_required'],
  ] as const)('rejects inconsistent source evidence: %s', async (change, reason) => {
    await db.query(change, [contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'blocked', reason });
    expect(await admissionCount()).toBe(0);
  });

  it.each([
    ["jsonb_set(snapshot,'{outreach_profile}','\"editorial\"'::jsonb)", 'media_contract_required'],
    ["snapshot-'outreach_profile'", 'media_contract_required'],
    ["jsonb_set(snapshot,'{commission_recurring}','50'::jsonb)", 'media_contract_snapshot_invalid'],
    ["jsonb_set(snapshot,'{commission_first_payment}','\"30\"'::jsonb)", 'media_contract_snapshot_invalid'],
    ["jsonb_set(snapshot,'{eligible_offer}','{}'::jsonb)", 'media_contract_snapshot_invalid'],
    ["jsonb_set(snapshot,'{media_contract_terms}','{}'::jsonb)", 'media_contract_snapshot_invalid'],
    ["jsonb_set(snapshot,'{media_contract_terms,extra}','\"Undeclared term\"'::jsonb)", 'media_contract_snapshot_invalid'],
  ] as const)('requires the precise media policy and complete explicit terms: %s', async (expression, reason) => {
    await db.query(`UPDATE purama_ai.partner_contract_dispatches SET snapshot=${expression} WHERE contract_id=$1`, [contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'blocked', reason });
    expect(await admissionCount()).toBe(0);
  });

  it('preserves an existing admission and rejects a subsequent source rewrite', async () => {
    const first = await prepare();
    await db.query("UPDATE purama_ai.partner_contract_dispatches SET snapshot=jsonb_set(snapshot,'{media_contract_terms,costs}','\"Different commercial clause must not rewrite the signed dossier\"'::jsonb) WHERE contract_id=$1", [contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'blocked', reason: 'admission_source_changed' });
    expect((await db.query<{ snapshot: Row }>('SELECT snapshot FROM purama_ai.partner_affiliation_admissions')).rows)
      .toEqual([{ snapshot: (first.admission as Row).snapshot }]);
    expect(await admissionCount()).toBe(1);
  });

  it('requires every additional signer to have completed the same contract', async () => {
    await db.query("INSERT INTO purama_ai.contract_signers(contract_id,email,name,role,docuseal_submitter_id) VALUES($1,'witness@example.invalid','Fixture Witness','witness',457)", [contract.contract_id]);
    expect(await prepare()).toMatchObject({ status: 'blocked', reason: 'signature_evidence_required' });
    expect(await admissionCount()).toBe(0);
  });
});

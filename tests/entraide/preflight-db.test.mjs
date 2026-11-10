import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { asRole, callRpc, createDb, seedUsers, USERS } from './db-harness.mjs';

// The first pending migration must reject an incompatible installation before
// it commits ANY contact RPC or ACL changes. Do not surround its own BEGIN /
// COMMIT with a test transaction: that would hide a partially committed rollout.
// Private shapes below are inert synthetic fixtures, not copied private code.
const migrations = new URL('../../supabase/migrations/', import.meta.url);
const skipped = [
  '20261110020000_entraide_contact_atomic.sql',
  '20261110021000_entraide_missions_atomic.sql',
  '20261110022000_entraide_mission_requests.sql',
];
const firstMigration = await readFile(new URL(skipped[0], migrations), 'utf8');
const pr17 = await readFile(new URL('./fixtures/pr17-20261110000000_entraide_missions_atomic.sql', import.meta.url), 'utf8');
assert.equal(createHash('sha256').update(pr17).digest('hex'), 'f79766b153806bdd6aac382b66c1d8495133c766fc35a50675a32894670d7c36');
const legacySignature = 'purama_ai.entraide_mission_mutate(uuid,text,uuid,jsonb,bigint)';
const stamp = '2026-10-01T12:00:00.000Z';

async function seedExistingState(db) {
  await seedUsers(db, [USERS.a, USERS.b, USERS.c]);
  await db.query(`INSERT INTO purama_ai.entraide_profils
    (user_id,skills_offered,skills_needed,availability_days,radius_km,location_lat,location_lng,created_at,updated_at)
    VALUES($1,ARRAY['synthetic skill'],ARRAY['synthetic need'],ARRAY['mon'],10,48,2,$2,$2)`,
  [USERS.a, stamp]);
  const mission = randomUUID();
  await db.query(`INSERT INTO purama_ai.missions_collectives
    (id,organizer_id,title,description,min_participants,max_participants,status,created_at,updated_at)
    VALUES($1,$2,'Existing synthetic mission','Preserve its history',2,4,'prete',$3,$3)`,
  [mission, USERS.a, stamp]);
  for (const user of [USERS.a, USERS.b]) {
    await db.query(`INSERT INTO purama_ai.missions_collectives_participants
      (mission_id,user_id,joined_at) VALUES($1,$2,$3)`, [mission, user, stamp]);
  }
  await db.query(`INSERT INTO purama_ai.entraide_contact_requests
    (id,requester_id,recipient_id,status,message,created_at,responded_at)
    VALUES($1,$2,$3,'accepted','Synthetic consent to preserve',$4,$4)`,
  [randomUUID(), USERS.a, USERS.b, stamp]);
  await db.query(`INSERT INTO purama_ai.entraide_blocages
    (blocker_id,blocked_id,created_at) VALUES($1,$2,$3)`, [USERS.a, USERS.c, stamp]);
}

async function snapshot(db) {
  const functions = (await db.query(`
    SELECT p.oid::regprocedure::text AS signature,
      pg_catalog.pg_get_functiondef(p.oid) AS definition,
      p.proacl::text AS acl, p.proowner::regrole::text AS owner
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='purama_ai'
    ORDER BY p.oid::regprocedure::text
  `)).rows;
  const tables = (await db.query(`
    SELECT c.relname, c.relacl::text AS acl, c.relrowsecurity, c.relforcerowsecurity,
      pg_catalog.obj_description(c.oid,'pg_class') AS comment
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='purama_ai' AND c.relkind IN ('r','p')
    ORDER BY c.relname
  `)).rows;
  const columns = (await db.query(`
    SELECT c.relname, a.attnum, a.attname,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull, a.attacl::text AS acl,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='purama_ai' AND c.relkind IN ('r','p')
      AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum
  `)).rows;
  const policies = (await db.query(`
    SELECT tablename,policyname,permissive,roles,cmd,qual,with_check
    FROM pg_catalog.pg_policies WHERE schemaname='purama_ai'
    ORDER BY tablename,policyname
  `)).rows;
  const constraints = (await db.query(`
    SELECT c.relname,k.conname,pg_catalog.pg_get_constraintdef(k.oid) AS definition
    FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid=k.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='purama_ai' ORDER BY c.relname,k.conname
  `)).rows;
  const data = {};
  for (const { relname } of tables) {
    // Identifier comes from this disposable database's catalog; quote it rather
    // than interpolating an unescaped identifier into the snapshot query.
    const quoted = `"${relname.replaceAll('"', '""')}"`;
    data[relname] = (await db.query(`SELECT to_jsonb(r) AS row
      FROM purama_ai.${quoted} r ORDER BY to_jsonb(r)::text`)).rows;
  }
  return { functions, tables, columns, policies, constraints, data };
}

async function refusesWithoutChanges(setup) {
  // Skipping current versions is test setup only. We intentionally reproduce
  // the pre-upgrade database, then invoke the first pending file directly.
  const db = await createDb({ alreadyApplied: skipped });
  try {
    await seedExistingState(db);
    await setup(db);
    const before = await snapshot(db);
    let refusal;
    try {
      await db.exec(firstMigration);
    } catch (error) {
      refusal = error;
    } finally {
      // A rejecting BEGIN/COMMIT migration leaves the connection aborted.
      // Roll back only AFTER that attempt, before observing the final state.
      await db.exec('ROLLBACK');
    }
    const after = await snapshot(db);
    assert.deepEqual(after, before,
      'An incompatible history must not leave committed RPC, ACL, policy, schema, data or receipt changes');
    assert.ok(refusal, 'The first pending migration must refuse this incompatible history');
    assert.equal(refusal.code, 'P0001');
    assert.equal(refusal.message, 'entraide_missions_reconciliation_required');
  } finally {
    await db.close();
  }
}

test('preflight refuses a private unified RPC before committing a second contact authority', async () => {
  await refusesWithoutChanges(db => db.exec(`
    CREATE FUNCTION purama_ai.entraide_command(p_action text,p_payload jsonb DEFAULT '{}')
      RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=''
      AS $$ SELECT '{"synthetic_private_authority":true}'::jsonb $$;
    REVOKE ALL ON FUNCTION purama_ai.entraide_command(text,jsonb) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION purama_ai.entraide_command(text,jsonb) TO authenticated;
  `));
});

test('preflight refuses private schema footprints even without the unified RPC', async () => {
  await refusesWithoutChanges(async db => {
    await db.exec(pr17);
    await db.exec(`
      ALTER TABLE purama_ai.entraide_profils ADD COLUMN is_active boolean NOT NULL DEFAULT false;
      ALTER TABLE purama_ai.missions_collectives ADD COLUMN visibility text NOT NULL DEFAULT 'private';
      ALTER TABLE purama_ai.missions_collectives ADD CONSTRAINT synthetic_visibility CHECK (visibility IN ('private','community'));
      ALTER TABLE purama_ai.entraide_contact_requests
        ADD COLUMN version integer NOT NULL DEFAULT 1,
        ADD COLUMN expires_at timestamptz,
        ADD COLUMN create_operation_id uuid,
        ADD COLUMN create_payload jsonb,
        ADD COLUMN create_fingerprint text;
      REVOKE ALL ON purama_ai.entraide_blocages,purama_ai.entraide_contact_requests
        FROM authenticated,service_role;
      CREATE POLICY synthetic_private_contacts ON purama_ai.entraide_contact_requests
        AS RESTRICTIVE FOR ALL TO authenticated USING (false) WITH CHECK (false);
    `);
  });
});

test('preflight refuses an unknown contact RPC without replacing its body or grants', async () => {
  await refusesWithoutChanges(db => db.exec(`
    CREATE FUNCTION purama_ai.entraide_contact_command(p_actor uuid,p_action text,p_payload jsonb DEFAULT '{}')
      RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=''
      AS $$ SELECT '{"synthetic_foreign_contact":true}'::jsonb $$;
    REVOKE ALL ON FUNCTION purama_ai.entraide_contact_command(uuid,text,jsonb) FROM PUBLIC,service_role;
    GRANT EXECUTE ON FUNCTION purama_ai.entraide_contact_command(uuid,text,jsonb) TO authenticated;
  `));
});

test('preflight refuses exact PR17 authority with a pre-existing visibility column', async () => {
  await refusesWithoutChanges(async db => {
    await db.exec(pr17);
    await db.exec("ALTER TABLE purama_ai.missions_collectives ADD COLUMN visibility text NOT NULL DEFAULT 'private'");
  });
});

test('preflight refuses altered PR17 authority before any contact RPC or ACL installation', async () => {
  await refusesWithoutChanges(async db => {
    await db.exec(pr17);
    await db.exec(`CREATE OR REPLACE FUNCTION purama_ai.entraide_mission_mutate(
      p_request_id uuid,p_action text,p_mission_id uuid DEFAULT NULL,
      p_payload jsonb DEFAULT '{}',p_expected_version bigint DEFAULT NULL)
      RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=''
      AS $$ SELECT '{"synthetic_altered_mission":true}'::jsonb $$`);
  });
});

test('preflight refuses an orphan mission receipt registry without adopting it', async () => {
  await refusesWithoutChanges(async db => {
    await db.exec(pr17);
    await db.exec(`DROP FUNCTION ${legacySignature}`);
    await db.exec('ALTER TABLE purama_ai.missions_collectives DROP COLUMN version');
  });
});

test('preflight refuses an orphan mission version column without a known authority or registry', async () => {
  await refusesWithoutChanges(db => db.exec(
    'ALTER TABLE purama_ai.missions_collectives ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0)',
  ));
});

test('preflight preserves an incompatible committed PR17 receipt instead of partially upgrading contacts', async () => {
  await refusesWithoutChanges(async db => {
    await db.exec(pr17);
    const requestId = randomUUID();
    const result = await asRole(db, 'authenticated', USERS.a,
      `SELECT purama_ai.entraide_mission_mutate($1::uuid,'create',NULL,$2::jsonb,NULL) AS result`,
      [requestId, JSON.stringify({ title: 'Synthetic receipt', description: 'History to preserve', min_participants: 2, max_participants: 4 })]);
    assert.ok(result.rows[0].result.mission.id);
    // A later protocol may use additional actions. Its receipt must not be
    // silently treated as an original #17 write, dropped or rewritten.
    await db.query(`UPDATE purama_ai.entraide_mission_requests SET action='publish'
      WHERE actor_id=$1 AND request_id=$2`, [USERS.a, requestId]);
  });
});

test('preflight resumes the exact contact-only installation without changing it and completes both protocols', async () => {
  const db = await createDb({ alreadyApplied: skipped });
  try {
    await seedExistingState(db);
    // Each invocation owns its BEGIN/COMMIT. An outer test transaction would
    // conceal whether retrying the first committed migration is actually safe.
    await db.exec(firstMigration);
    const partial = await snapshot(db);
    await db.exec(firstMigration);
    assert.deepEqual(await snapshot(db), partial,
      'Retrying the exact contact-only installation must preserve every function, ACL, policy, schema and row');

    for (const name of skipped.slice(1)) {
      await db.exec(await readFile(new URL(name, migrations), 'utf8'));
    }

    const existingContacts = await callRpc(db, 'entraide_contact_command', USERS.a, 'list');
    assert.deepEqual(existingContacts.requests,
      partial.data.entraide_contact_requests.map(({ row }) => row));
    assert.deepEqual(existingContacts.blocked_user_ids, [USERS.c]);

    const missionPayload = {
      id: randomUUID(), request_id: randomUUID(), title: 'Resumed installation',
      description: 'Synthetic protocol verification', min_participants: 2,
    };
    const created = await callRpc(db, 'entraide_mission_command', USERS.a, 'create', missionPayload);
    assert.ok(created.mission, JSON.stringify(created));
    assert.equal(created.mission.id, missionPayload.id);
    assert.equal(created.mission.visibility, 'private');
    assert.equal(created.mission.revision, 0);
    assert.equal(created.replayed, false);
    assert.deepEqual(await callRpc(db, 'entraide_mission_command', USERS.a, 'create', missionPayload),
      { ...created, replayed: true });
    // Receipt mission_id records the input target, which is absent on create.
    // The created ID is checked above and preserved in response.mission.id.
    assert.deepEqual((await db.query(`SELECT action,mission_id,response
      FROM purama_ai.entraide_mission_requests WHERE actor_id=$1 AND request_id=$2`,
    [USERS.a, missionPayload.request_id])).rows, [
      { action: 'create', mission_id: null, response: { mission: created.mission } },
    ]);

    const contactId = randomUUID();
    const sent = await callRpc(db, 'entraide_contact_command', USERS.b, 'send', {
      id: contactId, recipient_id: USERS.c, message: 'Synthetic resumed contact',
    });
    assert.ok(sent.request, JSON.stringify(sent));
    assert.equal(sent.request.id, contactId);
    assert.equal(sent.request.status, 'pending');
    const accepted = await callRpc(db, 'entraide_contact_command', USERS.c, 'respond', {
      request_id: contactId, response: 'accept',
    });
    assert.equal(accepted.request?.status, 'accepted');
    assert.deepEqual((await db.query(`SELECT requester_id,recipient_id,status
      FROM purama_ai.entraide_contact_requests WHERE id=$1`, [contactId])).rows, [
      { requester_id: USERS.b, recipient_id: USERS.c, status: 'accepted' },
    ]);
  } finally {
    await db.close();
  }
});

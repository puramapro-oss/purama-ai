import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/20261003190400_contact_submissions.sql', import.meta.url), 'utf8');
const form = readFileSync(new URL('../src/components/Contact.tsx', import.meta.url), 'utf8');

test('contact table is private and public writes can only use the RPC', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE purama_ai\.contact_submissions FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /CREATE POLICY[\s\S]+contact_submissions/i);
  assert.match(migration, /SECURITY DEFINER[\s\S]+SET search_path = pg_catalog, purama_ai, extensions, pg_temp/);
  assert.match(migration, /REVOKE ALL ON FUNCTION purama_ai\.submit_contact[\s\S]+FROM PUBLIC/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION purama_ai\.submit_contact[\s\S]+TO anon, authenticated/);
});

test('contact RPC validates bounds, honeypot, timing and concurrent quotas', () => {
  assert.match(migration, /char_length\(v_name\) NOT BETWEEN 2 AND 100/);
  assert.match(migration, /char_length\(v_message\) NOT BETWEEN 10 AND 2000/);
  assert.match(migration, /coalesce\(p_website, ''\) <> ''/);
  assert.match(migration, /interval '2 seconds'/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, />= 3/);
  assert.match(migration, />= 10/);
  assert.doesNotMatch(migration, /RETURN QUERY|RETURNS SETOF|RETURNS TABLE/i);
});

test('contact form uses the bounded RPC and exposes submission errors accessibly', () => {
  assert.match(form, /\.rpc\('submit_contact'/);
  assert.doesNotMatch(form, /\.from\('contact_submissions'\)/);
  assert.match(form, /role="alert"/);
  assert.match(form, /aria-live="assertive"/);
  assert.match(form, /minLength=\{10\}/);
  assert.match(form, /p_website: website/);
});

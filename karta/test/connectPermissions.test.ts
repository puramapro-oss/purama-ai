import {beforeAll,afterAll,expect,it} from 'vitest';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db:PGlite;
const owner='00000000-0000-4000-8000-000000000021';
const other='00000000-0000-4000-8000-000000000022';
beforeAll(async()=>{
  db=new PGlite();
  await db.exec("CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('test.user_id',true),'')::uuid $$;CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;");
  for(const name of ['20260422180000_v4_1_stripe_connect_opentimestamps.sql','20260919160000_connect_accounts_server_writes.sql'])
    await db.exec(await readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8'));
  await db.query('INSERT INTO auth.users VALUES($1),($2)',[owner,other]);
  await db.query("INSERT INTO public.connect_accounts(user_id,stripe_account_id) VALUES($1,'acct_owner'),($2,'acct_other')",[owner,other]);
  await db.query("SELECT set_config('test.user_id',$1,false)",[owner]);
});
afterAll(async()=>{await db?.close();});
it('allows a signed-in user to read only their own mapping',async()=>{
  await db.exec('SET ROLE authenticated');try {expect((await db.query('SELECT stripe_account_id FROM public.connect_accounts')).rows).toEqual([{stripe_account_id:'acct_owner'}]);} finally {await db.exec('RESET ROLE');}
});
it('denies changing even the owner\'s Stripe account identifier',async()=>{
  await db.exec('SET ROLE authenticated');try {await expect(db.query("UPDATE public.connect_accounts SET stripe_account_id='acct_victim' WHERE user_id=$1",[owner])).rejects.toThrow(/permission denied/);} finally {await db.exec('RESET ROLE');}
});
it('denies deletion of authorization mappings by clients',async()=>{
  await db.exec('SET ROLE authenticated');try {await expect(db.query('DELETE FROM public.connect_accounts WHERE user_id=$1',[owner])).rejects.toThrow(/permission denied/);} finally {await db.exec('RESET ROLE');}
});
it('preserves writes by the server role',async()=>{
  await db.exec('SET ROLE service_role');try {await db.query('UPDATE public.connect_accounts SET onboarding_completed=true WHERE user_id=$1',[owner]);expect((await db.query('SELECT onboarding_completed FROM public.connect_accounts WHERE user_id=$1',[owner])).rows[0]).toEqual({onboarding_completed:true});} finally {await db.exec('RESET ROLE');}
});

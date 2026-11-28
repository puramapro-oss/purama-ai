import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const handlerUrl=new URL('../../supabase/functions/email-agent-reconcile-draft/handler.ts',import.meta.url).href;
const { createDraftReconciler }=await import(/* @vite-ignore */ handlerUrl);
type Row=Record<string,unknown>;
const user='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
const log='00000000-0000-4000-8000-000000000011', action='00000000-0000-4000-8000-000000000021';
const secondAction='00000000-0000-4000-8000-000000000022';
const owner='owner@example.invalid';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    INSERT INTO auth.users VALUES ('${user}'),('${other}');`);
  for(const file of ['20260406210000_email_agent.sql','20261122004000_email_agent_send_reservations.sql',
    '20261122020000_email_agent_draft_approvals.sql',
    '20261122021000_email_agent_send_reconciliation.sql']) {
    await db.exec(readFileSync(new URL('../../supabase/migrations/'+file,import.meta.url),'utf8'));
  }
  vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Real network is forbidden in this suite');}));
});
beforeEach(async()=>{
  await db.exec('RESET ROLE; TRUNCATE purama_ai.email_agent_dispatches, purama_ai.email_agent_draft_previews, purama_ai.email_agent_logs, purama_ai.email_agent_config');
  await db.query(`INSERT INTO purama_ai.email_agent_config(user_id,gmail_email,total_auto_replied) VALUES($1,$2,7),($3,'other@example.invalid',0)`,[user,owner,other]);
  await db.query(`INSERT INTO purama_ai.email_agent_logs(id,user_id,gmail_message_id,gmail_thread_id,from_email,category,action_taken,
    ai_subject,ai_response,user_approved,created_at) VALUES($1,$2,'incoming-1','thread-1','recipient@example.invalid','normal','draft',
    'Re: Approved subject','Approved body',true,clock_timestamp())`,[log,user]);
  await db.query(`INSERT INTO purama_ai.email_agent_dispatches(id,user_id,gmail_message_id,log_id,status,payload,provider_message_id,dispatch_started_at)
    SELECT $1,user_id,gmail_message_id,id,'unknown',purama_ai.email_agent_send_payload(l)||jsonb_build_object('gmail_email',$2::text),
    'sent-1',clock_timestamp()-interval '10 seconds' FROM purama_ai.email_agent_logs l WHERE id=$3`,[action,owner,log]);
});
afterAll(async()=>{await db?.close();vi.unstubAllGlobals();});
const fnArgs:Record<string,string[]>={
  email_agent_reconcile_context:['p_user_id','p_log_id'],
  email_agent_reconcile_finish:['p_user_id','p_action_id','p_dispatch_updated_at','p_connection_email','p_connection_updated_at',
    'p_provider_message_id','p_raw_sha256','p_provider_internal_date_ms'],
};
async function rpc(name:string,args:Row):Promise<{data:Row|null;error:unknown}>{
  const keys=fnArgs[name];if(!keys) throw new Error('Unexpected RPC '+name);
  try{
    const r=await db.query<{value:Row}>(`SELECT purama_ai.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) value`,keys.map(k=>args[k]??null));
    return {data:r.rows[0].value,error:null};
  }catch(error){return {data:null,error};}
}
async function cfg(){return (await db.query<{gmail_email:string;stamp:string;total_auto_replied:number}>(
  'SELECT gmail_email,updated_at::text stamp,total_auto_replied FROM purama_ai.email_agent_config WHERE user_id=$1',[user])).rows[0];}
async function state(){return (await db.query<Row>('SELECT * FROM purama_ai.email_agent_dispatches WHERE id=$1',[action])).rows[0];}
function request(body:unknown={log_id:log},token='valid'){
  return new Request('https://example.invalid/reconcile',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
}
function raw(overrides:{from?:string;to?:string;subject?:string;body?:string;reply?:string;extra?:string}={}){
  return Buffer.from(`From: ${overrides.from??owner}\r\nTo: ${overrides.to??'recipient@example.invalid'}\r\nSubject: ${overrides.subject??'Re: Approved subject'}\r\n`
    +`In-Reply-To: ${overrides.reply??'<parent@example.invalid>'}\r\nReferences: <parent@example.invalid>\r\n`
    +(overrides.extra??'')+'MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n'+(overrides.body??'Approved body')).toString('base64url');
}
type Options={identity?:string;actor?:string;message?:Row;ids?:string[];onRead?:()=>Promise<void>;
  rawResponse?:()=>Response;failAt?:'context'|'finish_before'|'finish_after';providerFailure?:boolean};
function harness(options:Options={}){
  const reads:string[]=[];
  const handler=createDraftReconciler({
    authenticate:async(token:string)=>token==='valid'?(options.actor??user):null,
    rpc:async(name:string,args:Row)=>{
      if(options.failAt==='context'&&name==='email_agent_reconcile_context') return {data:null,error:new Error('DB unavailable')};
      if(name==='email_agent_reconcile_finish'&&options.failAt?.startsWith('finish')){
        if(options.failAt==='finish_after') await rpc(name,args);
        return {data:null,error:new Error('Lost database acknowledgement')};
      }
      return rpc(name,args);
    },
    prepareAccess:async()=>{const c=await cfg();return {accessToken:'test-only-token',gmailEmail:c.gmail_email,connectionUpdatedAt:c.stamp};},
    fetch:async(url:string|URL|Request,init?:RequestInit)=>{
      expect(init?.method).toBe('GET');expect(init?.signal).toBeInstanceOf(AbortSignal);reads.push(String(url));
      if(options.providerFailure) throw new Error('Provider unavailable');
      if(String(url).endsWith('/profile')) return Response.json({emailAddress:options.identity??owner});
      if(String(url).includes('/messages/incoming-1?format=metadata')) return Response.json({id:'incoming-1',threadId:'thread-1',payload:{headers:[
        {name:'Message-ID',value:'<parent@example.invalid>'},{name:'From',value:'recipient@example.invalid'},{name:'Subject',value:'Approved subject'},
      ]}});
      if(String(url).includes('/threads/thread-1?format=minimal')) return Response.json({id:'thread-1',messages:(options.ids??['sent-1']).map(id=>({id,threadId:'thread-1',labelIds:['SENT']}))});
      const id=String(url).match(/\/messages\/([^/?]+)\?format=raw$/)?.[1];expect(id).toBeTruthy();
      await options.onRead?.();if(options.rawResponse) return options.rawResponse();
      return Response.json({id,threadId:'thread-1',labelIds:['SENT'],raw:raw(),internalDate:String(Date.now()),...options.message});
    },
  });
  return {handler,reads};
}
describe('Gmail reconciliation confirms evidence without sending or granting a retry',()=>{
  it.each([
    ['',false],['a',true],['a'.repeat(255),true],['a'.repeat(256),true],
    ['a'.repeat(512),true],['a'.repeat(513),false],['a/b',false],['a b',false],['a\n',false],
  ])('validates provider id bounds without raising a SQL regexp error: %j',async(id,valid)=>{
    const c=await cfg();
    const reply=await rpc('email_agent_reconcile_finish',{
      p_user_id:user,p_action_id:secondAction,p_dispatch_updated_at:c.stamp,
      p_connection_email:owner,p_connection_updated_at:c.stamp,
      p_provider_message_id:id,p_raw_sha256:'a'.repeat(64),p_provider_internal_date_ms:Date.now(),
    });
    expect(reply.error).toBeNull();
    expect(reply.data).toMatchObject({reason:valid?'dispatch_not_found':'invalid_provider_evidence'});
    expect((await state()).status).toBe('unknown');
    expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('confirms a saved receipt and atomically updates the log and counter once',async()=>{
    const h=harness();const response=await h.handler(request());
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({status:'sent',reconciled:true,matches_current_preview:true,provider_message_id:'sent-1',provider_check_performed:true});
    expect((await state()).reconciliation_proof).toMatchObject({source:'gmail_messages_get',known_receipt:true,matched_snapshot:true});
    expect((await state()).reconciled_at).toBeTruthy();expect((await cfg()).total_auto_replied).toBe(8);
    expect(h.reads).toHaveLength(3);expect(h.reads.every(url=>!url.endsWith('/send'))).toBe(true);
    const replay=harness();const replayResponse=await replay.handler(request());expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toMatchObject({provider_check_performed:false});
    expect(replay.reads).toHaveLength(0);expect((await cfg()).total_auto_replied).toBe(8);
  });
  it('finds one matching SENT message in the bounded original thread when the receipt was lost',async()=>{
    await db.query('UPDATE purama_ai.email_agent_dispatches SET provider_message_id=NULL WHERE id=$1',[action]);
    const h=harness();expect((await h.handler(request())).status).toBe(200);
    expect(h.reads.some(x=>x.includes('/threads/'))).toBe(true);expect((await state()).reconciliation_proof).toMatchObject({known_receipt:false});
  });
  it('does not decide between two matching messages',async()=>{
    await db.query('UPDATE purama_ai.email_agent_dispatches SET provider_message_id=NULL WHERE id=$1',[action]);
    const h=harness({ids:['sent-1','sent-2']});const response=await h.handler(request());
    expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:'multiple_matching_sent_messages'});
    expect((await state()).status).toBe('unknown');expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('does not treat an empty or excessive thread search as permission to send',async()=>{
    await db.query('UPDATE purama_ai.email_agent_dispatches SET provider_message_id=NULL WHERE id=$1',[action]);
    for(const ids of [[],Array.from({length:6},(_,i)=>'sent-'+i)]){
      const h=harness({ids});expect((await h.handler(request())).status).toBe(409);
      expect(h.reads).toHaveLength(3);expect((await state()).status).toBe('unknown');
    }
  });
  it.each([
    ['wrong sender',{raw:raw({from:'other@example.invalid'})}],['wrong recipient',{raw:raw({to:'other@example.invalid'})}],
    ['changed subject',{raw:raw({subject:'Changed'})}],['changed body',{raw:raw({body:'Changed'})}],
    ['wrong parent',{raw:raw({reply:'<other@example.invalid>'})}],['extra recipient',{raw:raw({extra:'Cc: extra@example.invalid\r\n'})}],
    ['wrong thread',{threadId:'other-thread'}],['wrong message id',{id:'other-message'}],
    ['not sent',{labelIds:['INBOX']}],['still draft',{labelIds:['SENT','DRAFT']}],
    ['missing timestamp',{internalDate:null}],['invalid timestamp',{internalDate:'NaN'}],
    ['future timestamp',{internalDate:String(Date.now()+3_600_000)}],
  ])('rejects %s evidence and preserves the unknown outcome',async(_name,message)=>{
    const h=harness({message:message as Row});expect((await h.handler(request())).status).toBe(409);
    expect((await state()).status).toBe('unknown');expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('rejects a thread candidate predating this attempt but preserves a known provider receipt',async()=>{
    const old=String(Date.now()-3_600_000);
    await db.query('UPDATE purama_ai.email_agent_dispatches SET provider_message_id=NULL WHERE id=$1',[action]);
    expect((await harness({message:{internalDate:old}}).handler(request())).status).toBe(409);
    await db.query("UPDATE purama_ai.email_agent_dispatches SET provider_message_id='sent-1' WHERE id=$1",[action]);
    expect((await harness({message:{internalDate:old}}).handler(request())).status).toBe(200);
  });
  it('rejects a profile that does not own the reserved Gmail account',async()=>{
    const h=harness({identity:'attacker@example.invalid'});expect((await h.handler(request())).status).toBe(409);expect(h.reads).toHaveLength(1);
    expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('rejects a reconnection that happens while the provider proof is being read',async()=>{
    const h=harness({onRead:async()=>{await db.query("UPDATE purama_ai.email_agent_config SET gmail_email='replacement@example.invalid' WHERE user_id=$1",[user]);}});
    const response=await h.handler(request());expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:'gmail_connection_changed'});
    expect((await state()).status).toBe('unknown');expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('confirms the older snapshot without marking a later edited draft as sent',async()=>{
    const h=harness({onRead:async()=>{await db.query("UPDATE purama_ai.email_agent_logs SET ai_response='New draft' WHERE id=$1",[log]);}});
    const response=await h.handler(request());expect(response.status).toBe(200);expect(await response.json()).toMatchObject({matches_current_preview:false});
    const item=(await db.query<Row>('SELECT action_taken,ai_response FROM purama_ai.email_agent_logs WHERE id=$1',[log])).rows[0];
    expect(item).toMatchObject({action_taken:'draft',ai_response:'New draft'});
  });
  it('preserves a later approval revocation, its feedback and its exact timestamp',async()=>{
    const h=harness({onRead:async()=>{await db.query(`UPDATE purama_ai.email_agent_logs
      SET user_approved=false,user_feedback='Do not approve a retry',feedback_at='2026-11-22T01:23:45.123Z' WHERE id=$1`,[log]);}});
    expect((await h.handler(request())).status).toBe(200);
    expect((await db.query<Row>(`SELECT user_approved,user_feedback,
      feedback_at='2026-11-22T01:23:45.123Z'::timestamptz AS exact_timestamp
      FROM purama_ai.email_agent_logs WHERE id=$1`,[log])).rows[0]).toMatchObject({
      user_approved:false,user_feedback:'Do not approve a retry',exact_timestamp:true});
  });
  it('serializes twenty concurrent confirmations and counts only once',async()=>{
    const h=harness();const results=await Promise.all(Array.from({length:20},()=>h.handler(request())));
    expect(results.every((r:Response)=>r.status===200)).toBe(true);expect((await cfg()).total_auto_replied).toBe(8);
    expect((await state()).status).toBe('sent');
  });
  it.each(['finish_before','finish_after'] as const)('keeps an explicit unknown response after %s and safely rereads',async failAt=>{
    expect((await harness({failAt}).handler(request())).status).toBe(409);
    expect((await harness().handler(request())).status).toBe(200);expect((await cfg()).total_auto_replied).toBe(8);
  });
  it('cannot reuse the receipt already attached to another intention',async()=>{
    await db.query(`INSERT INTO purama_ai.email_agent_dispatches(id,user_id,gmail_message_id,log_id,status,payload,provider_message_id)
      VALUES($1,$2,'another-incoming',$3,'sent','{}','sent-1')`,[secondAction,user,log]);
    const response=await harness().handler(request());expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({reason:'provider_receipt_already_used'});expect((await cfg()).total_auto_replied).toBe(7);
  });
  it('does not guess the account of historical dispatches',async()=>{
    await db.query("UPDATE purama_ai.email_agent_dispatches SET payload=payload-'gmail_email',dispatch_started_at=NULL WHERE id=$1",[action]);
    const h=harness();const response=await h.handler(request());expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({reason:'historical_connection_unverified'});expect(h.reads).toHaveLength(0);
  });
  it('leaves a currently sending action in progress until its observation delay has elapsed',async()=>{
    await db.query("UPDATE purama_ai.email_agent_dispatches SET status='sending',dispatch_started_at=clock_timestamp() WHERE id=$1",[action]);
    const h=harness();expect((await h.handler(request())).status).toBe(409);expect(h.reads).toHaveLength(0);
    await db.query("UPDATE purama_ai.email_agent_dispatches SET dispatch_started_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",[action]);
    expect((await h.handler(request())).status).toBe(200);
  });
  it('rejects unauthenticated, cross-account and client-supplied proof inputs before Gmail access',async()=>{
    const h=harness();expect((await h.handler(request(undefined,'bad'))).status).toBe(401);
    expect((await h.handler(request({log_id:log,provider_message_id:'forged'}))).status).toBe(400);
    const otherUser=harness({actor:other});expect((await otherUser.handler(request())).status).toBe(409);
    expect(h.reads).toHaveLength(0);expect(otherUser.reads).toHaveLength(0);
  });
  it('bounds request and provider bodies and preserves errors as unresolved',async()=>{
    expect((await harness().handler(request({log_id:log,padding:'x'.repeat(5000)}))).status).toBe(400);
    for(const rawResponse of [()=>new Response('{broken'),()=>new Response('x'.repeat(2_100_001))]){
      expect((await harness({rawResponse}).handler(request())).status).toBe(503);expect((await state()).status).toBe('unknown');
    }
    expect((await harness({providerFailure:true}).handler(request())).status).toBe(503);
    expect((await harness({failAt:'context'}).handler(request())).status).toBe(503);
  });
  it('keeps both reconciliation RPCs private to service_role',async()=>{
    for(const role of ['anon','authenticated']){
      await db.exec('SET ROLE '+role);
      const attempt=await rpc('email_agent_reconcile_context',{p_user_id:user,p_log_id:log});expect(attempt.error).toBeTruthy();
      const finish=await rpc('email_agent_reconcile_finish',{p_user_id:user,p_action_id:action});expect(finish.error).toBeTruthy();
      await db.exec('RESET ROLE');
    }
  });
});

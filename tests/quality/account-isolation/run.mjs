/* global process */
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=path.resolve(process.argv[2]||path.join(here,'../../..'));
const evidence=path.resolve(process.env.ACCOUNT_ISOLATION_EVIDENCE||path.join(here,'evidence'));
const require=createRequire(path.join(source,'package.json'));
const {build}=require('esbuild');
const {chromium,expect}=require('@playwright/test');
const sourceFiles=['src/components/auth/ProtectedRoute.tsx','src/pages/PartnerAgentEmails.tsx','src/pages/ComptaAgentSettings.tsx','src/components/dashboard/ExecutionCounter.tsx','src/hooks/useVoice.tsx','src/components/voice/AgentChatTab.tsx','src/pages/LegalAgentChat.tsx','src/pages/CreatorAgentDetail.tsx','src/hooks/useCreatorAgentKarta.ts'];
try{await access(path.join(source,'src/hooks/useRequestScope.ts'));sourceFiles.push('src/hooks/useRequestScope.ts');}catch{/* The unpatched parent has no request scope helper. */}
const digest=async()=>Object.fromEntries(await Promise.all(sourceFiles.map(async file=>[file,createHash('sha256').update(await readFile(path.join(source,file))).digest('hex')])));
const result={status:'RUNNING',startedAt:new Date().toISOString(),source,sourceSha256:await digest(),node:process.version,backend:'simulated',externalRequests:[],checks:[]};
let server,browser,origin;
const checkpoint=async()=>{await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'results.json'),JSON.stringify(result,null,2)+'\n');};
const errors=[];
const filter=process.env.ACCOUNT_ISOLATION_FILTER?new RegExp(process.env.ACCOUNT_ISOLATION_FILTER):null;
let selectedChecks=0;
const user=id=>({id,email:id.toLowerCase()+'@example.test'});
const pending=(page,name,args)=>page.waitForFunction(({name,args})=>window.__pending.some(x=>x.name===name&&JSON.stringify(x.args)===JSON.stringify(args)),{name,args});
const resolve=(page,name,args,value)=>page.evaluate(({name,args,value})=>window.__resolve(name,args,value),{name,args,value});
const switchTo=async(page,id)=>{await page.evaluate(user=>window.__setUser(user),user(id));await expect(page.getByTestId('account')).toHaveText(id);};
const tick=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const email=id=>({id:'mail-'+id,user_id:id,subject:'PRIVATE_EMAIL_'+id,body_html:'<p>synthetic</p>',type:'outreach',status:'sent',created_at:'2026-11-10T00:00:00Z',sent_at:'2026-11-10T00:00:00Z',opened:false,clicked:false,replied:false});
const voice=id=>({provider:'openai',voice_id:'VOICE_'+id,speed:1,auto_play:false,enabled:true,language:'fr'});
const usage=id=>({used:id==='A'?111:222,limit:999,percent:10,plan:{name:'PRIVATE_PLAN_'+id},days_until_reset:20});
const config=id=>({id:'config-'+id,user_id:id,company_name:'PRIVATE_COMPANY_'+id,legal_form:'sarl',fiscal_regime:'is',tva_regime:'reel_normal',bridge_accounts:[],invoice_prefix:id,invoice_next_number:1});
const message=(owner,session,content)=>({id:owner+'-'+session,role:'assistant',user_id:owner,agent_type:'compta',session_id:session,content,created_at:'2026-11-10T00:00:00Z'});
const agent=id=>({id,user_id:'A',name:'PRIVATE_AGENT_'+id,description:'fixture',emoji:'',is_template:false,is_active:true,tools_enabled:[],model:'gpt-4o-mini',system_prompt:'fixture',temperature:1,max_tokens:100,total_runs:0,total_tokens:0,schedule_type:'manual',karta_enabled:false});
async function check(name,type,fn){
 if(filter&&!filter.test(name))return;
 selectedChecks++;
 const context=await browser.newContext();
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();result.externalRequests.push(url.origin);return route.abort();});
 const page=await context.newPage();page.on('pageerror',e=>errors.push({name,message:e.message}));page.setDefaultTimeout(6000);page.setDefaultNavigationTimeout(30000);
 await page.addInitScript(()=>{
   window.__audioCreated=0;window.__audioPlayed=0;window.__audioPaused=0;window.__urlsCreated=0;window.__urlsRevoked=0;window.__tracksStopped=0;window.__recordersCreated=0;window.__microRequests=0;
   window.Audio=class {constructor(){window.__audioCreated++;this.src='';}async play(){window.__audioPlayed++;}pause(){window.__audioPaused++;}};
   URL.createObjectURL=()=>{window.__urlsCreated++;return 'blob:fixture-'+window.__urlsCreated;};URL.revokeObjectURL=()=>{window.__urlsRevoked++;};
   Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(resolve=>{window.__microRequests++;window.__resolveMicrophone=()=>resolve({getTracks:()=>[{stop:()=>{window.__tracksStopped++;}}]});})}});
   window.MediaRecorder=class {static isTypeSupported(){return true;}constructor(){window.__recordersCreated++;window.__recorder=this;this.mimeType='audio/webm';this.state='inactive';}start(){this.state='recording';}stop(){this.state='inactive';queueMicrotask(()=>this.onstop?.());}};
 });
 try{await page.goto(origin+'/?component='+type);await expect(page.getByTestId('account')).toHaveText(type.includes('anonymous=1')?'anonymous':'A');const observed=await fn(page);result.checks.push({name,status:'PASS',...observed});console.log('PASS '+name);}
 catch(error){result.checks.push({name,status:'FAIL',message:error.message});console.error('FAIL '+name+' '+error.message);}
 finally{await context.close();await checkpoint();}
}
try{
 const aliases={'real-karta-hooks':path.join(source,'src/hooks/useCreatorAgentKarta.ts'),'@/integrations/supabase/client':path.join(here,'supabase.js'),'@/hooks/useAuth':path.join(here,'auth.jsx'),'@/hooks/useCreatorAgentKarta':path.join(here,'api.js')};
 for(const module of ['partner','compta','voice','usage','agent-chat','legal','creator-agent'])aliases['@/lib/'+module]=path.join(here,'api.js');
 for(const module of ['voice/VoiceMode','voice/MicButton','voice/SpeakButton','karta/PendingActionsList'])aliases['@/components/'+module]=path.join(here,'children.jsx');
 aliases['@']=path.join(source,'src');
 const built=await build({entryPoints:[path.join(here,'entry.jsx')],bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.join(source,'node_modules')],define:{'process.env.NODE_ENV':'"test"'},alias:aliases,plugins:[{name:'fixture-relative-auth',setup(build){build.onResolve({filter:/^\.\/useAuth$/},()=>({path:path.join(here,'auth.jsx')}));}}]});
 const bundle=built.outputFiles[0].contents;result.bundleBytes=bundle.byteLength;result.bundleSha256=createHash('sha256').update(bundle).digest('hex');
 server=createServer((req,res)=>{if(req.url==='/bundle.js'){res.setHeader('content-type','text/javascript');res.end(bundle);}else{res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+server.address().port;
 await checkpoint();
 const executablePath=process.env.PLAYWRIGHT_EXECUTABLE_PATH;
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});result.browser=browser.version();

 await check('account change rejects the previous email response','emails',async page=>{
 await pending(page,'emails',['A']);await switchTo(page,'B');await pending(page,'emails',['B']);await resolve(page,'emails',['B'],[email('B')]);await expect(page.getByText('PRIVATE_EMAIL_B')).toBeVisible();await resolve(page,'emails',['A'],[email('A')]);await tick(page);assert.equal(await page.getByText('PRIVATE_EMAIL_A').count(),0);await expect(page.getByText('PRIVATE_EMAIL_B')).toBeVisible();});

 await check('account change clears configuration before the next account can save','compta',async page=>{
 await pending(page,'compta',['A']);await resolve(page,'compta',['A'],config('A'));await expect(page.locator('input').first()).toHaveValue('PRIVATE_COMPANY_A');await switchTo(page,'B');await pending(page,'compta',['B']);assert.equal(await page.getByRole('button',{name:'Enregistrer',exact:true}).count(),0);assert.equal(await page.locator('input').count(),0);await resolve(page,'compta',['B'],config('B'));await expect(page.locator('input').first()).toHaveValue('PRIVATE_COMPANY_B');await page.getByRole('button',{name:'Enregistrer',exact:true}).click();const writes=await page.evaluate(()=>window.__calls.filter(x=>x.name==='saveCompta'));assert.equal(writes.length,1);assert.equal(writes[0].args[0],'B');assert.equal(writes[0].args[1].company_name,'PRIVATE_COMPANY_B');return {legitimateSave:writes[0]};});

 await check('voice outside the route shows defaults while a new identity loads','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await expect(page.getByTestId('voice')).toContainText('VOICE_A');await switchTo(page,'B');await pending(page,'voice',['B']);const state=JSON.parse(await page.getByTestId('voice').textContent());assert.equal(state.settings.voice_id,'nova');assert.equal(state.loading,true);await resolve(page,'voice',['B'],voice('B'));await expect(page.getByTestId('voice')).toContainText('VOICE_B');});

 await check('voice outside the route rejects a save response from the previous identity','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await expect(page.getByTestId('voice')).toContainText('VOICE_A');await page.evaluate(()=>{window.__voice.updateSettings({voice_id:'VOICE_A_SAVED'});});await pending(page,'saveVoice',['A',{voice_id:'VOICE_A_SAVED'}]);await switchTo(page,'B');await pending(page,'voice',['B']);await resolve(page,'voice',['B'],voice('B'));await expect(page.getByTestId('voice')).toContainText('VOICE_B');await resolve(page,'saveVoice',['A',{voice_id:'VOICE_A_SAVED'}],{...voice('A'),voice_id:'VOICE_A_SAVED'});await tick(page);await expect(page.getByTestId('voice')).toContainText('VOICE_B');});

 await check('usage outside the route hides the previous account while loading','usage&unprotected=1',async page=>{
 await pending(page,'usage',['A','a@example.test']);await resolve(page,'usage',['A','a@example.test'],usage('A'));await expect(page.getByText('PRIVATE_PLAN_A')).toBeVisible();await switchTo(page,'B');await pending(page,'usage',['B','b@example.test']);assert.equal(await page.getByText('PRIVATE_PLAN_A').count(),0);await resolve(page,'usage',['B','b@example.test'],usage('B'));await expect(page.getByText('PRIVATE_PLAN_B')).toBeVisible();});

 await check('usage reloads when the same identity changes email','usage',async page=>{
 await pending(page,'usage',['A','a@example.test']);await resolve(page,'usage',['A','a@example.test'],usage('A'));await expect(page.getByText('PRIVATE_PLAN_A')).toBeVisible();await page.evaluate(()=>window.__setUser({id:'A',email:'changed@example.test'}));await pending(page,'usage',['A','changed@example.test']);await resolve(page,'usage',['A','changed@example.test'],usage('CHANGED'));await expect(page.getByText('PRIVATE_PLAN_CHANGED')).toBeVisible();});

 await check('same account refresh and query changes preserve current form state','probe',async page=>{
 await page.getByRole('button',{name:'Counter 0'}).click();await page.evaluate(()=>window.__setUser({id:'A',email:'a@example.test',updated_at:'token-refresh'}));await page.evaluate(()=>window.__navigate('/review?filter=new'));await expect(page.getByRole('button',{name:'Counter 1'})).toBeVisible();assert.equal(await page.evaluate(()=>window.__mounts),1);await switchTo(page,'B');await expect(page.getByRole('button',{name:'Counter 0'})).toBeVisible();assert.equal(await page.evaluate(()=>window.__mounts),2);});

 await check('dynamic agent navigation rejects the previous agent response','creator',async page=>{
 await pending(page,'agent',['alpha']);await page.evaluate(()=>window.__navigate('/agents/beta'));await pending(page,'agent',['beta']);await resolve(page,'agent',['beta'],agent('beta'));await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_beta'})).toBeVisible();await resolve(page,'agent',['alpha'],agent('alpha'));await tick(page);assert.equal(await page.getByRole('heading',{name:'PRIVATE_AGENT_alpha'}).count(),0);await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_beta'})).toBeVisible();});

 await check('voice rejects an old A response even after an A-B-A identity cycle','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await expect(page.getByTestId('voice')).toContainText('VOICE_A');await page.evaluate(()=>{window.__voice.updateSettings({voice_id:'STALE_A'});});await pending(page,'saveVoice',['A',{voice_id:'STALE_A'}]);await switchTo(page,'B');await pending(page,'voice',['B']);await switchTo(page,'A');await pending(page,'voice',['A']);await resolve(page,'voice',['A'],{...voice('A'),voice_id:'CURRENT_A'});await expect(page.getByTestId('voice')).toContainText('CURRENT_A');await resolve(page,'saveVoice',['A',{voice_id:'STALE_A'}],{...voice('A'),voice_id:'STALE_A'});await tick(page);await expect(page.getByTestId('voice')).toContainText('CURRENT_A');});

 await check('voice save still updates the current identity','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await expect(page.getByTestId('voice')).toContainText('VOICE_A');await page.evaluate(()=>{window.__voice.updateSettings({voice_id:'SAVED_A'});});await pending(page,'saveVoice',['A',{voice_id:'SAVED_A'}]);await resolve(page,'saveVoice',['A',{voice_id:'SAVED_A'}],{...voice('A'),voice_id:'SAVED_A'});await expect(page.getByTestId('voice')).toContainText('SAVED_A');});

 await check('late speech from the previous identity cannot start audio','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await expect(page.getByTestId('voice')).toContainText('VOICE_A');await page.evaluate(()=>{window.__voice.speak('PRIVATE_A');});await pending(page,'speak',['PRIVATE_A']);await switchTo(page,'B');await pending(page,'voice',['B']);await page.evaluate(()=>window.__resolve('speak',['PRIVATE_A'],new Blob(['fixture'],{type:'audio/mpeg'})));await tick(page);assert.equal(await page.evaluate(()=>window.__audioCreated),0);assert.equal(await page.evaluate(()=>window.__calls.filter(x=>x.name==='browserSpeak').length),0);});

 await check('microphone permission returned after identity change releases its tracks','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await page.evaluate(()=>{window.__voice.startRecording();});await page.waitForFunction(()=>typeof window.__resolveMicrophone==='function');await switchTo(page,'B');await pending(page,'voice',['B']);await page.evaluate(()=>window.__resolveMicrophone());await tick(page);assert.equal(await page.evaluate(()=>window.__tracksStopped),1);assert.equal(await page.evaluate(()=>window.__recordersCreated),0);});

 await check('speech returned after unmount cannot start audio','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await page.evaluate(()=>{window.__voice.speak('UNMOUNTED_A');});await pending(page,'speak',['UNMOUNTED_A']);await page.evaluate(()=>window.__hide());await expect(page.getByTestId('voice')).toHaveCount(0);await page.evaluate(()=>window.__resolve('speak',['UNMOUNTED_A'],new Blob(['fixture'],{type:'audio/mpeg'})));await tick(page);assert.equal(await page.evaluate(()=>window.__audioCreated),0);});

 await check('current speech plays and stopping it revokes its object URL','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await page.evaluate(()=>{window.__voice.speak('CURRENT_A');});await pending(page,'speak',['CURRENT_A']);await page.evaluate(()=>window.__resolve('speak',['CURRENT_A'],new Blob(['fixture'],{type:'audio/mpeg'})));await page.waitForFunction(()=>window.__audioPlayed===1);await page.evaluate(()=>window.__voice.stopSpeaking());assert.equal(await page.evaluate(()=>window.__audioPaused),1);assert.equal(await page.evaluate(()=>window.__urlsRevoked),1);});

 await check('agent chat ignores history from a previous session','agentChat',async page=>{
 await pending(page,'agentMessages',['A','compta','session-1']);await page.getByRole('button',{name:'Nouvelle',exact:true}).click();await pending(page,'agentMessages',['A','compta','session-2']);await resolve(page,'agentMessages',['A','compta','session-2'],[message('A','session-2','CURRENT_SESSION_2')]);await expect(page.getByText('CURRENT_SESSION_2')).toBeVisible();await resolve(page,'agentMessages',['A','compta','session-1'],[message('A','session-1','STALE_SESSION_1')]);await tick(page);assert.equal(await page.getByText('STALE_SESSION_1').count(),0);await expect(page.getByText('CURRENT_SESSION_2')).toBeVisible();});

 await check('legal chat hides old history while another session loads','legalChat',async page=>{
 await pending(page,'legalSessions',['A']);await resolve(page,'legalSessions',['A'],[{session_id:'saved-session',title:'SAVED_SESSION',created_at:'2026-11-10T00:00:00Z'}]);await pending(page,'messages',['A','session-1']);await resolve(page,'messages',['A','session-1'],[message('A','session-1','OLD_LEGAL_MESSAGE')]);await expect(page.getByText('OLD_LEGAL_MESSAGE')).toBeVisible();await page.getByRole('button',{name:'SAVED_SESSION'}).click();await pending(page,'messages',['A','saved-session']);assert.equal(await page.getByText('OLD_LEGAL_MESSAGE').count(),0);await resolve(page,'messages',['A','saved-session'],[message('A','saved-session','CURRENT_LEGAL_MESSAGE')]);await expect(page.getByText('CURRENT_LEGAL_MESSAGE')).toBeVisible();});

 await check('usage is safe on an anonymous mount and after logout','usage&unprotected=1&anonymous=1',async page=>{
 assert.equal(await page.locator('a').count(),0);await switchTo(page,'A');await pending(page,'usage',['A','a@example.test']);await resolve(page,'usage',['A','a@example.test'],usage('A'));await expect(page.getByText('PRIVATE_PLAN_A')).toBeVisible();await page.evaluate(()=>window.__setUser(null));await expect(page.getByTestId('account')).toHaveText('anonymous');assert.equal(await page.getByText('PRIVATE_PLAN_A').count(),0);});

 const kartaTables=['karta_agent_state','karta_runs','karta_pending_actions'];
 async function loadKarta(page,id){for(const table of kartaTables){await pending(page,'sql',[table,id,'custom:shared-agent']);const row={id:table+'-'+id,user_id:id,marker:'PRIVATE_KARTA_'+id,agent_type:'custom:shared-agent'};await resolve(page,'sql',[table,id,'custom:shared-agent'],{data:table==='karta_agent_state'?row:[row],error:null});}await expect(page.getByTestId('karta')).toContainText('PRIVATE_KARTA_'+id);}
 await check('creator cache never displays the previous principal in the real QueryClient','karta',async page=>{
 await loadKarta(page,'A');await switchTo(page,'B');assert.equal((await page.getByTestId('karta').textContent()).includes('PRIVATE_KARTA_A'),false);await loadKarta(page,'B');const keys=await page.evaluate(()=>window.__queryClient.getQueryCache().getAll().map(q=>q.queryKey));assert.equal(keys.length,6);return {cacheKeys:keys};});

 await check('creator cache invalidation follows the actual writer after identity changes','karta&unprotected=1',async page=>{
 await loadKarta(page,'A');await page.evaluate(()=>window.__updateKarta.mutate({kill_switch:true}));await pending(page,'upsert',['karta_agent_state','A','custom:shared-agent']);await switchTo(page,'B');
 const refreshNeeded=await page.evaluate(()=>!window.__pending.some(x=>x.name==='sql'&&x.args[1]==='B'));
 if(refreshNeeded)await page.evaluate(()=>{window.__queryClient.refetchQueries({type:'active'});});
 await loadKarta(page,'B');const before=await page.evaluate(()=>window.__calls.filter(x=>x.name==='sql'&&x.args[1]==='B').length);
 await resolve(page,'upsert',['karta_agent_state','A','custom:shared-agent'],{error:null});await tick(page);await tick(page);
 const after=await page.evaluate(()=>window.__calls.filter(x=>x.name==='sql'&&x.args[1]==='B').length);assert.equal(after,before);await expect(page.getByTestId('karta')).toContainText('PRIVATE_KARTA_B');
 await page.evaluate(()=>window.__updateKarta.mutate({kill_switch:false}));await pending(page,'upsert',['karta_agent_state','B','custom:shared-agent']);await resolve(page,'upsert',['karta_agent_state','B','custom:shared-agent'],{error:null});await pending(page,'sql',['karta_agent_state','B','custom:shared-agent']);await resolve(page,'sql',['karta_agent_state','B','custom:shared-agent'],{data:{user_id:'B',marker:'CURRENT_KARTA_B_SAVED'},error:null});await expect(page.getByTestId('karta')).toContainText('CURRENT_KARTA_B_SAVED');return {previousMutationDidNotRefetchB:true,currentMutationRefetchedB:true,refreshNeeded};});

 await check('voice refuses an overlapping recorder until its transcription settles','voice&unprotected=1',async page=>{
 await pending(page,'voice',['A']);await resolve(page,'voice',['A'],voice('A'));await page.evaluate(()=>{window.__voice.startRecording();});await page.waitForFunction(()=>window.__microRequests===1);await page.evaluate(()=>window.__resolveMicrophone());await page.waitForFunction(()=>window.__recordersCreated===1);
 await page.evaluate(()=>{window.__recorder.ondataavailable({data:new Blob(['x'.repeat(300)])});window.__voice.stopRecording().then(value=>{window.__transcript=value;});});await pending(page,'transcribe',[]);await page.evaluate(()=>{window.__voice.startRecording();});await tick(page);assert.equal(await page.evaluate(()=>window.__microRequests),1);
 await resolve(page,'transcribe',[],'CURRENT_TRANSCRIPT');await page.waitForFunction(()=>window.__transcript==='CURRENT_TRANSCRIPT');await page.evaluate(()=>{window.__voice.startRecording();});await page.waitForFunction(()=>window.__microRequests===2);await page.evaluate(()=>window.__resolveMicrophone());await page.waitForFunction(()=>window.__recordersCreated===2);await page.evaluate(()=>window.__voice.cancelRecording());return {transcription:'CURRENT_TRANSCRIPT',secondRecordingAllowedAfterCompletion:true};});

 await check('legal chat cannot start a follow-up request after its account leaves','legalChat',async page=>{
 await pending(page,'legalSessions',['A']);await resolve(page,'legalSessions',['A'],[]);await pending(page,'messages',['A','session-1']);await resolve(page,'messages',['A','session-1'],[]);await page.locator('textarea').fill('PRIVATE_QUESTION_A');await page.locator('textarea').press('Enter');await pending(page,'legalSend',['session-1','PRIVATE_QUESTION_A']);await switchTo(page,'B');await pending(page,'legalSessions',['B']);await resolve(page,'legalSessions',['B'],[]);await resolve(page,'legalSend',['session-1','PRIVATE_QUESTION_A'],{reply:'STALE_REPLY_A',sources:[]});await tick(page);assert.equal(await page.getByText('STALE_REPLY_A').count(),0);assert.equal(await page.evaluate(()=>window.__calls.filter(x=>x.name==='legalSessions'&&x.args[0]==='A').length),1);});

 await check('creator missing response finishes loading and retry can recover','creator',async page=>{
 await pending(page,'agent',['alpha']);await resolve(page,'agent',['alpha'],null);await expect(page.getByRole('alert')).toContainText('introuvable');await page.getByRole('button',{name:'Réessayer',exact:true}).click();await pending(page,'agent',['alpha']);await resolve(page,'agent',['alpha'],agent('alpha'));await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_alpha'})).toBeVisible();assert.equal(await page.getByRole('alert').count(),0);});

 await check('creator rejected response finishes loading and allows navigation back','creator',async page=>{
 await pending(page,'agent',['alpha']);await page.evaluate(()=>window.__reject('agent',['alpha'],'Synthetic service unavailable'));await expect(page.getByRole('alert')).toContainText('Impossible');await page.getByRole('link',{name:'Retour aux agents',exact:true}).click();await expect(page.getByTestId('path')).toHaveText('/dashboard/creator-agent');});

 await check('creator old delete completion cannot navigate away from the next agent','creator',async page=>{
 await pending(page,'agent',['alpha']);await resolve(page,'agent',['alpha'],agent('alpha'));await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_alpha'})).toBeVisible();await page.getByRole('tab',{name:/Paramètres/}).click();page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Supprimer',exact:true}).click();await pending(page,'agentDelete',['alpha']);await page.evaluate(()=>window.__navigate('/agents/beta'));await pending(page,'agent',['beta']);await resolve(page,'agent',['beta'],agent('beta'));await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_beta'})).toBeVisible();await resolve(page,'agentDelete',['alpha'],undefined);await tick(page);await expect(page.getByTestId('path')).toHaveText('/agents/beta');await expect(page.getByRole('heading',{name:'PRIVATE_AGENT_beta'})).toBeVisible();});

 await check('agent initial history cannot replace a newer optimistic send','agentChat',async page=>{
 await pending(page,'agentMessages',['A','compta','session-1']);await page.locator('textarea').fill('CURRENT_QUESTION');await page.locator('textarea').press('Enter');await pending(page,'agentSend',['compta','session-1','CURRENT_QUESTION']);await resolve(page,'agentMessages',['A','compta','session-1'],[]);await tick(page);await expect(page.getByText('CURRENT_QUESTION',{exact:true})).toBeVisible();await resolve(page,'agentSend',['compta','session-1','CURRENT_QUESTION'],{reply:'CURRENT_REPLY',tokens:10});await expect(page.getByText('CURRENT_REPLY',{exact:true})).toBeVisible();});

} catch(error){result.fatal=error.stack;} finally{
 await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());result.finishedAt=new Date().toISOString();result.selectedChecks=selectedChecks;result.filter=filter?.source??null;result.pageErrors=errors;result.sourceSha256After=await digest();result.sourceUnchanged=JSON.stringify(result.sourceSha256)===JSON.stringify(result.sourceSha256After);result.status=!result.fatal&&result.sourceUnchanged&&!errors.length&&!result.externalRequests.length&&selectedChecks>0&&result.checks.length===selectedChecks&&result.checks.every(x=>x.status==='PASS')?'PASS':'FAIL';await checkpoint();console.log(JSON.stringify({status:result.status,pass:result.checks.filter(x=>x.status==='PASS').length,fail:result.checks.filter(x=>x.status==='FAIL').length,pageErrors:errors,fatal:result.fatal,sourceUnchanged:result.sourceUnchanged}));if(result.status!=='PASS')process.exitCode=1;
}

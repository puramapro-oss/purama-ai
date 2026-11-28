from pathlib import Path
import subprocess,json,hashlib,datetime,os,time,signal,traceback
BASE=Path('/Users/matissdornier/purama-patches/iao-tool-cancellation-20261126-4f357a4b')
REPO=BASE/'source';OUT=BASE/'reconciliation-893';NODE=BASE/'runtime-node22/bin/node';META=OUT/'final-gate.json'
START=time.monotonic();DEADLINE=START+1500
ENV=os.environ.copy();ENV['PATH']=str(NODE.parent)+os.pathsep+ENV.get('PATH','')
EXCLUSIONS=[':(exclude,glob).env*',':(exclude,glob)**/.env*',':(exclude,glob)**/.env*/**',':(exclude,glob)**/qa/**',':(exclude,glob)**/QA/**',':(exclude,glob)**/doc/**',':(exclude,glob)**/docs/**',':(exclude,glob)**/documentation/**',':(exclude,glob)**/*.md',':(exclude,glob)**/*.mdx']
SCOPES=['karta/src','karta/test','karta/migrations','karta/scripts','supabase/functions','supabase/migrations','src','scripts',':(glob)karta/*.json','karta/vitest.config.ts',':(glob)karta/*.config.*','package.json','package-lock.json',':(glob)tsconfig*.json',':(glob)*.config.ts',':(glob)*.config.js']
def utc():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def run(args):return subprocess.run(args,cwd=REPO,capture_output=True,text=True,check=True).stdout
def git(*args):return run(['git',*args]).strip()
def git_state():
 return {'head':git('rev-parse','HEAD'),'merge_head':git('rev-parse','MERGE_HEAD'),'write_tree':git('write-tree'),'unmerged_exit':subprocess.run(['git','diff','--quiet','--diff-filter=U'],cwd=REPO).returncode,'status':run(['git','status','--porcelain=v1','--untracked-files=no','--','.',*EXCLUSIONS]).splitlines()}
def inventory():
 paths=set(filter(None,run(['git','ls-files','-z','--cached','--others','--exclude-standard','--',*SCOPES,*EXCLUSIONS]).split('\0')))
 return sorted(p for p in paths if not any(x.startswith('.env') or x.lower() in {'qa','doc','docs','documentation'} for x in Path(p).parts) and Path(p).suffix.lower() not in {'.md','.mdx'})
def snapshot():
 result={}
 for name in inventory():
  path=REPO/name
  if path.is_symlink():result[name]='symlink:'+os.readlink(path)
  elif path.is_file():result[name]=hashlib.sha256(path.read_bytes()).hexdigest()
  else:result[name]='MISSING'
 return result
def aggregate(values):return hashlib.sha256(json.dumps(values,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
old_names=['full-karta.json','full-karta.log','final-gate.json','typecheck.log','build.log','parallel-2-reception/full-karta.json','parallel-2-reception/full-karta.log','parallel-2-reception/final-gate.json','sql-cohort-recheck.json','sql-cohort-recheck.log','sql-cohort-recheck-metadata.json']
def old_snapshot(names):return {name:sha(BASE/name) if (BASE/name).is_file() else 'MISSING' for name in names}
data={'state':'preflight','started_at_utc':utc(),'runner_pid':os.getpid(),'timeout_seconds':1500,'cwd':str(REPO/'karta'),'path_override_scope':'subprocess only; runtime-node22/bin prepended','hash_scope':SCOPES,'hash_exclusions':EXCLUSIONS,'steps':[]}
def save():
 temp=META.with_suffix('.json.tmp');temp.write_text(json.dumps(data,indent=2)+'\n');temp.replace(META)
def execute_step(name,args):
 log=OUT/(name+'.log');entry={'name':name,'command':args,'started_at_utc':utc(),'state':'running','log':str(log)};data['steps'].append(entry);data['active_step']=name;save()
 print('STEP_START',json.dumps({'name':name,'started_at_utc':entry['started_at_utc'],'command':args}),flush=True)
 started=time.monotonic()
 with log.open('x') as output:
  process=subprocess.Popen(args,cwd=REPO/'karta',env=ENV,stdout=output,stderr=subprocess.STDOUT,start_new_session=True);entry['pid']=process.pid;save()
  try:entry['exit_code']=process.wait(timeout=max(1,DEADLINE-time.monotonic()))
  except subprocess.TimeoutExpired:
   entry['timeout']=True;os.killpg(process.pid,signal.SIGTERM)
   try:process.wait(timeout=5)
   except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait()
   entry['exit_code']=process.returncode
 entry.update({'finished_at_utc':utc(),'duration_seconds':round(time.monotonic()-started,3),'state':'finished','log_sha256':sha(log)})
 save();print('STEP_END',json.dumps({k:entry[k] for k in ['name','exit_code','duration_seconds','log_sha256']}),flush=True)
 if entry.get('timeout'):raise TimeoutError('Collector deadline reached in '+name)
try:
 data['node_version']=run([str(NODE),'--version']).strip();assert data['node_version']=='v22.23.5'
 data['git_before']=git_state()
 assert data['git_before']['head']=='9a2e4b59801974b4d61dcd9a6aa5d17512f5de6a'
 assert data['git_before']['merge_head']=='893fc5cb14e0039e40c060b51532ea0feefd1864'
 assert data['git_before']['write_tree']=='2ba3f2f56240595aee6a0e54a7dd700bd96217d3'
 assert data['git_before']['unmerged_exit']==0
 data['hashes_before']=snapshot();data['aggregate_before']=aggregate(data['hashes_before']);data['old_receipts_before']=old_snapshot([n for n in old_names if (BASE/n).is_file()]);data['state']='running';save()
 print('GATE_START',json.dumps({'node':data['node_version'],'started_at_utc':data['started_at_utc'],'runner_pid':data['runner_pid'],'hashed_paths':len(data['hashes_before']),'aggregate_before':data['aggregate_before']}),flush=True)
 execute_step('typecheck',[str(NODE),'node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.json'])
 execute_step('build',[str(NODE),'node_modules/typescript/bin/tsc','-p','tsconfig.build.json'])
 execute_step('full-karta',[str(NODE),'node_modules/vitest/vitest.mjs','run','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile.json='+str(OUT/'full-karta.json')])
except BaseException as error:
 data['collector_error']={'type':type(error).__name__,'message':str(error),'traceback':traceback.format_exc()};print('COLLECTOR_ERROR',json.dumps(data['collector_error']),flush=True)
finally:
 if 'hashes_before' in data:
  data['hashes_after']=snapshot();data['aggregate_after']=aggregate(data['hashes_after']);data['source_hashes_unchanged']=data['hashes_before']==data['hashes_after'];data['changed_paths']=[n for n in sorted(set(data['hashes_before'])|set(data['hashes_after'])) if data['hashes_before'].get(n)!=data['hashes_after'].get(n)]
  data['old_receipts_after']=old_snapshot(data['old_receipts_before']);data['old_receipts_unchanged']=data['old_receipts_before']==data['old_receipts_after'];data['git_after']=git_state();data['git_unchanged']=data['git_before']==data['git_after']
 report=OUT/'full-karta.json'
 if report.exists():
  result=json.loads(report.read_text());data['report_sha256']=sha(report);data['counts']={k:result.get(k) for k in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','success']};data['file_count']=len(result.get('testResults',[]));data['per_file']=[]
  for file in result.get('testResults',[]):
   tests=file.get('assertionResults',[]);data['per_file'].append({'name':str(Path(file['name']).relative_to(REPO/'karta')),'status':file.get('status'),'message':file.get('message',''),'duration_seconds':round((file.get('endTime',0)-file.get('startTime',0))/1000,3),'counts':{s:sum(t.get('status')==s for t in tests) for s in ['passed','failed','pending','skipped']},'failures':[{'name':t['fullName'],'messages':t.get('failureMessages',[])} for t in tests if t.get('status')=='failed']})
  text=(OUT/'full-karta.log').read_text(errors='replace');data['harness_error_markers']=[s for s in ['Unhandled Errors','Vitest caught','PromiseRejectionHandledWarning'] if s in text]
 data['state']='finished';data.pop('active_step',None);data['finished_at_utc']=utc();data['duration_seconds']=round(time.monotonic()-START,3)
 data['passed']=not data.get('collector_error') and len(data['steps'])==3 and all(s.get('exit_code')==0 for s in data['steps']) and data.get('source_hashes_unchanged') is True and data.get('old_receipts_unchanged') is True and data.get('git_unchanged') is True and data.get('counts',{}).get('success') is True and not data.get('harness_error_markers')
 save();print('GATE_END',json.dumps({k:data.get(k) for k in ['passed','finished_at_utc','duration_seconds','file_count','counts','source_hashes_unchanged','changed_paths','old_receipts_unchanged','git_unchanged','aggregate_after','report_sha256','harness_error_markers','collector_error']}),flush=True)
 print('FINAL_GATE_SHA256',sha(META),flush=True)

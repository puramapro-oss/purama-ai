import datetime,hashlib,json,os,pathlib,subprocess,time
r=pathlib.Path(__file__).resolve().parent;root=r.parent;p=root/'source'
assert (r/'final-gate.json').exists(), 'combined gate must finish before indexing'
g=json.loads((r/'final-gate.json').read_text())
assert g.get('status')=='PASS', 'gate is not PASS'
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def git(*args):return subprocess.check_output(['git',*args],cwd=p,text=True).strip()
assert git('rev-parse','HEAD')=='9a2e4b59801974b4d61dcd9a6aa5d17512f5de6a'
assert git('rev-parse','MERGE_HEAD')=='893fc5cb14e0039e40c060b51532ea0feefd1864'
assert not git('ls-files','-u')
record={'started_at_utc':now(),'gate':'final-gate.json','status_before':git('status','--porcelain=v1'),'commands':[],'index_scope':'Full materialized repository using default GitNexus filters; no modified exclusion rules or context injection.'}
env=os.environ.copy();env.update({'GITNEXUS_HOME':str(root/'gitnexus-home'),'GITNEXUS_MEMORY':'off','NODE_OPTIONS':'--max-old-space-size=4096'})
cli='/Users/matissdornier/.local/bin/gitnexus'
command=[cli,'analyze',str(p),'--index-only','--workers','1','--skip-fts','--name','purama-iao-cancellation-20261126-4f357a4b']
start=time.monotonic();error=None
try:
 with (r/'gitnexus-index.log').open('wb') as f:s=subprocess.run(command,cwd=p,env=env,stdout=f,stderr=subprocess.STDOUT,timeout=1200);code=s.returncode
except subprocess.TimeoutExpired:code=124;error='index timeout'
record['commands'].append({'command':command,'exit_code':code,'duration_seconds':round(time.monotonic()-start,3),'log':'gitnexus-index.log','sha256':hashlib.sha256((r/'gitnexus-index.log').read_bytes()).hexdigest(),'error':error})
(r/'gitnexus-reception.json').write_text(json.dumps(record,indent=2)+'\n')
if code==0:
 for name,args in [('gitnexus-all.json',['--scope','all']),('gitnexus-compare-main.json',['--scope','compare','--base-ref','origin/main']),('gitnexus-compare-upstream.json',['--scope','compare','--base-ref','893fc5cb14e0039e40c060b51532ea0feefd1864'])]:
  cmd=[cli,'detect_changes','--repo',str(p),'--limit','500',*args];start=time.monotonic();v=subprocess.run(cmd,cwd=p,env=env,capture_output=True,text=True,timeout=120)
  item={'command':cmd,'exit_code':v.returncode,'duration_seconds':round(time.monotonic()-start,3),'stdout':v.stdout,'stderr':v.stderr,'checked_at_utc':now()};(r/name).write_text(json.dumps(item,indent=2)+'\n');record['commands'].append({'name':name,'exit_code':v.returncode,'duration_seconds':item['duration_seconds']})
record['finished_at_utc']=now();record['status_after']=git('status','--porcelain=v1');record['git_status_unchanged']=record['status_before']==record['status_after'];record['status']='PASS' if all(x['exit_code']==0 for x in record['commands']) and record['git_status_unchanged'] else 'PARTIEL'
(r/'gitnexus-reception.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'status':record['status'],'commands':[{k:x[k] for k in ['exit_code','duration_seconds'] if k in x} for x in record['commands']],'git_status_unchanged':record['git_status_unchanged']}))

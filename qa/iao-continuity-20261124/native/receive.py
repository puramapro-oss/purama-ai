import os,sys,json,subprocess,hashlib,base64,time,platform
from pathlib import Path
root=Path('/Users/matissdornier/purama-patches/iao-continuity-20261124-native')
repo=root/'repo'
base='e81129a56e07535129827c95211d82815df8dc5a'
node='/opt/homebrew/Cellar/node/26.0.0/bin/node'
deps=Path('/Users/matissdornier/purama-patches/iao-startup-integration-20261121-1a14/repo/node_modules')
browser='/Users/matissdornier/purama-patches/iao-startup-integration-20261121-1a14/playwright-browsers/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell'
attempt=sys.argv[1]
assert attempt.isdigit()
out=root/('attempt-'+attempt)
out.mkdir(exist_ok=False)
env={k:v for k,v in os.environ.items() if k in ('HOME','USER','LOGNAME','LANG','LC_ALL','SHELL')}
env.update(PATH='/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',CI='1',PLAYWRIGHT_EXECUTABLE_PATH=browser,TMPDIR=str(out/'tmp'))
(out/'tmp').mkdir()
def run(args,**kw): return subprocess.run(args,cwd=repo,env=env,text=True,capture_output=True,**kw)
assert run(['git','rev-parse','HEAD']).stdout.strip()==base
bundle=json.loads((root/'candidate.json').read_text())
assert bundle['base']==base
prior=root/'last-bundle.json'
prior_files={x['path']:x['sha256'] for x in json.loads(prior.read_text())['files']} if prior.exists() else {}
for item in bundle['files']:
 p=Path(item['path'])
 assert not p.is_absolute() and '..' not in p.parts and p.parts[0] in ('src','tests')
 target=repo/p
 raw=base64.b64decode(item['base64'],validate=True)
 assert hashlib.sha256(raw).hexdigest()==item['sha256']
 if item['path'] in prior_files:
  assert target.exists() and hashlib.sha256(target.read_bytes()).hexdigest()==prior_files[item['path']]
 elif target.exists():
  old=run(['git','show',base+':'+item['path']])
  assert old.returncode==0 and target.read_bytes()==old.stdout.encode()
 target.parent.mkdir(parents=True,exist_ok=True)
 target.write_bytes(raw)
prior.write_text(json.dumps(bundle))
for link in [repo/'node_modules',root/'node_modules']:
 if link.is_symlink(): assert link.resolve()==deps.resolve()
 else: assert not link.exists(); link.symlink_to(deps,target_is_directory=True)
paths=set(run(['git','ls-files','src','tests/chat','tests/workshop-state','supabase/functions/_shared','karta/src/api','karta/src/knowledge']).stdout.splitlines())
paths.update(x['path'] for x in bundle['files'])
def snapshot():
 return {p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in sorted(paths) if (repo/p).is_file()}
before=snapshot()
(out/'source-before.json').write_text(json.dumps(before,indent=2))
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()
receipt={'base':base,'sourceFiles':len(before),'sourceDigestBefore':digest(before),'candidateSha256':hashlib.sha256((root/'candidate.json').read_bytes()).hexdigest(),'candidateFiles':[{'path':x['path'],'sha256':x['sha256']} for x in bundle['files']],'platform':platform.platform(),'machine':platform.machine(),'node':run([node,'--version']).stdout.strip(),'versions':{},'browserExecutable':browser,'environment':'OS allowlist only; fixture transports, no model or production writes; existing dependencies reused read-only','runs':[]}
for name in ('@playwright/test','vite','react','i18next','react-router-dom'):
 receipt['versions'][name]=json.loads((deps/name/'package.json').read_text())['version']
for suite in ['workshop-state','chat']:
 resultdir=out/suite
 resultdir.mkdir()
 config=root/('native-'+suite+'.config.mts')
 config.write_text("import base from './repo/tests/"+suite+"/playwright.config.ts';\nexport default { ...base, testDir: "+json.dumps(str(repo/'tests'/suite))+", outputDir: "+json.dumps(str(resultdir/'results'))+", reporter: [['list'], ['json', {outputFile: "+json.dumps(str(resultdir/'report.json'))+"}]], use: {...base.use, launchOptions: {executablePath: "+json.dumps(browser)+", args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost']}} };\n")
 cmd=[node,str(deps/'@playwright/test/cli.js'),'test','--config',str(config)]
 started=time.time()
 try:
  result=run(cmd,timeout=300)
  code=result.returncode
  (resultdir/'run.log').write_text(result.stdout+'\n'+result.stderr)
 except subprocess.TimeoutExpired as exc:
  code=124
  (resultdir/'run.log').write_text(str(exc))
 record={'suite':suite,'command':cmd,'exitCode':code,'seconds':round(time.time()-started,3),'retryPolicy':0}
 if (resultdir/'report.json').exists():
  report=json.loads((resultdir/'report.json').read_text()); record['stats']=report.get('stats'); record['tests']=[]
  def walk(suites):
   for s in suites:
    for spec in s.get('specs',[]):
     for test in spec.get('tests',[]):
      record['tests'].append({'title':spec['title'],'status':test['status'],'results':[{'status':r['status'],'retry':r.get('retry'),'errors':[e.get('message','')[:1800] for e in r.get('errors',[])]} for r in test.get('results',[])]})
    walk(s.get('suites',[]))
  walk(report.get('suites',[]))
 receipt['runs'].append(record)
 (out/'receipt.json').write_text(json.dumps(receipt,indent=2))
after=snapshot()
(out/'source-after.json').write_text(json.dumps(after,indent=2))
receipt['sourceDigestAfter']=digest(after)
receipt['sourceUnchanged']=before==after
receipt['status']='PASS' if before==after and all(r['exitCode']==0 for r in receipt['runs']) else 'PARTIEL'
receipt['limits']=['Native macOS headless Chromium, not physical phone/headset or camera/AR','Existing node_modules differ from the exact committed lock; final CI still required','Only browser page traffic is locally fixture-isolated, not an OS-wide network certification']
(out/'receipt.json').write_text(json.dumps(receipt,indent=2))
print(json.dumps({'status':receipt['status'],'receipt':str(out/'receipt.json'),'sourceUnchanged':before==after,'runs':[{'suite':r['suite'],'exitCode':r['exitCode'],'stats':r.get('stats')} for r in receipt['runs']]}))

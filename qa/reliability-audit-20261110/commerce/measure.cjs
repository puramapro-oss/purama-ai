const fs=require('node:fs');
const path=require('node:path');
const { createRequire }=require('node:module');
const crypto=require('node:crypto');
const { performance }=require('node:perf_hooks');
const repo='/Users/matissdornier/purama-patches/reliability-audit-20261110-2127/code';
const localRequire=createRequire(path.join(repo,'karta/package.json'));
const ts=localRequire('typescript');
const {PGlite}=localRequire('@electric-sql/pglite');
const source=fs.readFileSync(path.join(repo,'karta/test/overageCredit.test.ts'),'utf8');
const ast=ts.createSourceFile('overageCredit.test.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='database');
if(!fn)throw new Error('Original database helper absent');
const original=fn.getText(ast);
const code=ts.transpileModule(original,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const sqls=['supabase/migrations/20260727020000_overage_credits.sql','supabase/migrations/20261110000200_overage_credit_idempotency.sql'].map(p=>fs.readFileSync(path.join(repo,p),'utf8'));
const database=new Function('PGlite','originalMigration','migration','owner','other',code+';return database;')(PGlite,...sqls,'00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102');
(async()=>{
 const started=performance.now();let db;let setupMs;let closeMs;
 try{db=await database(false);setupMs=performance.now()-started;}
 finally{if(db){const closeStarted=performance.now();await db.close();closeMs=performance.now()-closeStarted;}}
 const result={diagnostic_only:true,assertion_tests_executed:0,node:process.version,helper_sha256:crypto.createHash('sha256').update(original).digest('hex'),test_sha256:crypto.createHash('sha256').update(source).digest('hex'),setup_ms:setupMs,close_ms:closeMs,total_ms:performance.now()-started};
 fs.writeFileSync('/Users/matissdornier/purama-patches/commerce-phase-probe-20261110/phase-result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
})().catch(error=>{console.error(error);process.exitCode=1;});
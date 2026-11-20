import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexCliChefDriver } from '../../karta/src/chef/codex-cli-driver.js';
const cwd = await mkdtemp(join(tmpdir(), 'purama-atelier-check-'));
const git = (args: string[]) => execFileSync('git', ['-C',cwd,'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',...args], {encoding:'utf8'}).trim();
git(['init','-q']); git(['config','user.name','PURAMA isolated verification']); git(['config','user.email','verification@localhost']);
await writeFile(join(cwd,'README.md'),'Isolated PURAMA adapter check. Only index.html may be added. No deployments, secrets or network needed.\n');
git(['add','README.md']); git(['commit','-qm','Seed isolated verification']);
const driver = new CodexCliChefDriver({allowedRoots:[cwd],timeoutMs:180000,maxOutputBytes:1048576});
try {
 const result = await driver.run({schemaVersion:1,missionId:'00000000-0000-4000-8000-000000009001',taskId:'00000000-0000-4000-8000-000000009002',workerId:'isolated-verification',provider:'codex',fencingToken:1,attempt:1,briefHash:'a'.repeat(64),cwd,accessMode:'write',allowedPaths:['index.html'],instructions:'Crée seulement index.html : une page française autonome, responsive et accessible avec titre Atelier PURAMA, un bouton qui incrémente un compteur via JavaScript local, et aucune ressource externe. Vérifie la syntaxe. Ne lance aucune commande Git et ne touche pas au dossier .git : le serveur enregistrera la version après ton travail. Ne modifie pas README.md. Ne déploie et ne pousse rien. Réponse JSON strictement status et summary.'});
 console.log(JSON.stringify({kind:'LIVE_CODEX_CHECK',status:result.status,summary:result.summary.slice(0,1200),outputSha:result.outputSha,usage:result.usage,gitStatus:git(['status','--porcelain']),head:git(['rev-parse','HEAD']),directory:cwd},null,2));
} catch(error) { console.log(JSON.stringify({kind:'LIVE_CODEX_CHECK',status:'failed',error:error instanceof Error ? error.message : 'Unknown',directory:cwd})); process.exitCode=1; }

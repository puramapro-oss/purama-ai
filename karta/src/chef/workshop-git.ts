import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChefDriverRequest } from "./driver.js";
import { runChefProcess } from "./process.js";

function environment(index?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["PATH","HOME","TMPDIR","LANG","LC_ALL"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (index) env.GIT_INDEX_FILE = index;
  return env;
}
async function git(cwd: string, args: string[], signal?: AbortSignal, index?: string, input?: string): Promise<string> {
  if (["status","diff"].includes(args[0] ?? "")) {
    // Even status/diff may run a clean filter. Refuse configured local filters
    // before reading working-tree content; global/system configuration is disabled.
    const filters = await runChefProcess({
      command:"git",args:["config","--null","--name-only","--get-regexp","^filter\\..*\\.(clean|smudge|process)$"],
      cwd,env:environment(index),signal,timeoutMs:5000,maxOutputBytes:65_536,
      label:"Configuration Git atelier",abortMessage:"Enregistrement Git annulé",timeoutMessage:"Configuration Git expirée",
    });
    if (filters.exitCode !== 1 || filters.stdout) throw new Error("Filtres Git non autorisés pour l’enregistrement automatique");
  }
  const result = await runChefProcess({
    command: "git", args: ["-c","core.hooksPath=/dev/null","-c","core.fsmonitor=false",
      "-c","commit.gpgsign=false","-c","user.name=PURAMA CHEF","-c","user.email=chef@localhost",...args],
    cwd,env:environment(index),signal,input,timeoutMs:10_000,maxOutputBytes:2_097_152,
    label:"Git atelier",abortMessage:"Enregistrement Git annulé",timeoutMessage:"Enregistrement Git expiré",
  });
  if (result.exitCode !== 0) throw new Error("Révision Git Codex non confirmée");
  return result.stdout;
}
const list = (output: string): string[] => output.split("\0").filter(Boolean);
export interface WorkshopGitSnapshot { head: string; ref: string }
export async function captureWorkshopHead(cwd: string, signal?: AbortSignal): Promise<WorkshopGitSnapshot> {
  if ((await git(cwd,["status","--porcelain=v1","--untracked-files=all"],signal)).trim()) {
    throw new Error("Le dossier de travail doit être propre avant la mission");
  }
  const head = (await git(cwd,["rev-parse","--verify","HEAD"],signal)).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Révision Git Codex non confirmée");
  const ref = (await git(cwd,["symbolic-ref","HEAD"],signal)).trim();
  if (!ref.startsWith("refs/heads/")) throw new Error("Une branche de travail est requise");
  return {head,ref};
}
function allowed(path: string, roots: string[]): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || /[\0\r\n]/.test(path) ||
      path.split("/").some(p => p === ".." || p === "." || [".git",".gitattributes",".gitmodules"].includes(p.toLowerCase()) || !p)) return false;
  return roots.some(root => root !== "." && !root.startsWith("/") && !root.split("/").includes("..") &&
    (path === root || path.startsWith(root + "/")));
}

/**
 * Trusted, bounded publication into the local branch only. The model keeps its
 * workspace-write sandbox and never receives permission to edit Git metadata.
 * Plumbing + a private index bypass hooks, signing, filters and the model's index.
 */
export async function commitWorkshopChanges(request: ChefDriverRequest, initial: WorkshopGitSnapshot, signal?: AbortSignal): Promise<string> {
  const cwd = request.cwd;
  const initialHead = initial.head;
  if ((await git(cwd,["symbolic-ref","HEAD"],signal)).trim() !== initial.ref) throw new Error("La branche du projet a changé");
  if ((await git(cwd,["rev-parse","--verify","HEAD"],signal)).trim() !== initialHead) {
    throw new Error("La révision du projet a changé pendant la mission");
  }
  const paths = [...new Set([
    ...list(await git(cwd,["diff","--no-ext-diff","--no-renames","--name-only","-z","HEAD"],signal)),
    ...list(await git(cwd,["ls-files","--others","--exclude-standard","-z"],signal)),
  ])].sort();
  if (!paths.length) return initialHead;
  if (request.accessMode !== "write" || paths.length > 256 || paths.some(path => !allowed(path,request.allowedPaths))) {
    throw new Error("Modifications hors du périmètre autorisé");
  }
  const directory = await mkdtemp(join(tmpdir(),"purama-chef-index-"));
  const index = join(directory,"index");
  let resultSha: string | undefined;
  let cleanupFailed = false;
  try {
    await git(cwd,["read-tree",initialHead],signal,index);
    let totalBytes = 0;
    let fileNumber = 0;
    for (const path of paths) {
      if (signal?.aborted) throw new Error("Enregistrement Git annulé");
      const full = join(cwd,path);
      let stat;
      try { stat = await lstat(full); }
      catch(error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await git(cwd,["update-index","--force-remove","--",path],signal,index);
        continue;
      }
      if (!stat.isFile() || stat.size > 10*1024*1024 || (totalBytes += stat.size) > 25*1024*1024) {
        throw new Error("Artefact non admissible pour l’enregistrement automatique");
      }
      const file = await open(full,constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer;
      try {
        if (!(await file.stat()).isFile()) throw new Error("Artefact non régulier");
        const buffer = Buffer.alloc(stat.size+1);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(buffer,length,buffer.length-length,length);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length !== stat.size) throw new Error("Fichier modifié pendant l’enregistrement");
        bytes = buffer.subarray(0,length);
      } finally { await file.close(); }
      // Hash a private snapshot: no filters and no second read of model-controlled paths.
      const snapshot = join(directory,"blob-" + fileNumber++);
      await writeFile(snapshot,bytes,{mode:0o600,flag:"wx"});
      const sha = (await git(cwd,["hash-object","-w","--no-filters","--",snapshot],signal)).trim();
      if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Empreinte Git invalide");
      await git(cwd,["update-index","--add","--cacheinfo",stat.mode & 0o111 ? "100755" : "100644",sha,path],signal,index);
    }
    const tree = (await git(cwd,["write-tree"],signal,index)).trim();
    const sha = (await git(cwd,["commit-tree",tree,"-p",initialHead,"-m","CHEF: " + request.taskId],signal,index)).trim();
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("Commit Git invalide");
    // Compare-and-swap: never overwrite a concurrent commit.
    if ((await git(cwd,["symbolic-ref","HEAD"],signal)).trim() !== initial.ref) throw new Error("La branche du projet a changé");
    await git(cwd,["update-ref",initial.ref,sha,initialHead],signal);
    if ((await git(cwd,["symbolic-ref","HEAD"],signal)).trim() !== initial.ref) throw new Error("La branche du projet a changé");
    // Synchronize the real index without touching working files.
    await git(cwd,["read-tree",sha],signal);
    if ((await git(cwd,["status","--porcelain=v1","--untracked-files=all"],signal)).trim()) {
      throw new Error("Le dossier a changé pendant l’enregistrement; vérification requise");
    }
    resultSha = sha;
  } finally {
    try { await rm(directory,{recursive:true,force:true}); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed || !resultSha) throw new Error("Enregistrement Git non confirmé");
  return resultSha;
}

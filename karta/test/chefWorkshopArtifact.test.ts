import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWorkshopArtifact, isWorkshopExportPath, WORKSHOP_ARCHIVE_MAX_BYTES } from "../src/chef/workshop-artifact.js";
import type { WorkshopProject } from "../src/chef/workshop-config.js";

const execute = promisify(execFile);
const roots: string[] = [];
const gitEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@localhost", ...args], { cwd, env: gitEnv })).stdout.trim();
}
async function commit(cwd: string) { await git(cwd, "add", "--all"); await git(cwd, "commit", "-qm", "fixture"); return git(cwd, "rev-parse", "HEAD"); }
async function fixture() {
  const workdir = await mkdtemp(join(tmpdir(), "chef-artifact-")); roots.push(workdir);
  await git(workdir, "init", "-q", "-b", "workshop"); await mkdir(join(workdir, "site"));
  const html = "<!doctype html><html lang=\"fr\"><h1>Création vérifiée</h1><script>console.log('ok')</script></html>\n";
  await writeFile(join(workdir, "site/index.html"), html);
  await writeFile(join(workdir, "site/pixel.bin"), Buffer.from([0, 255, 1, 10, 128]));
  await writeFile(join(workdir, "private-outside.txt"), "NOT_EXPORTED");
  const sha = await commit(workdir);
  const project = { id: "atelier", workdir, allowedPaths: ["site"], previewEntry: "site/index.html" } as WorkshopProject;
  return { workdir, html, sha, project };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("immutable workshop source archives", () => {
  it("exports verified historical bytes, binary data and UTF-8 metadata despite a changed/dirty HEAD", async () => {
    const f = await fixture();
    await writeFile(join(f.workdir, "site/index.html"), "NEW_VERSION"); await commit(f.workdir);
    await writeFile(join(f.workdir, "site/index.html"), "UNCOMMITTED_VERSION");
    const result = await buildWorkshopArtifact(f.project, "mission", f.sha);
    const bytes = Buffer.from(result.archive.base64, "base64");
    expect(result).toMatchObject({ missionId: "mission", commitSha: f.sha,
      archive: { fileName: `atelier-${f.sha.slice(0,12)}.zip`, mediaType: "application/zip", bytes: bytes.length },
      preview: { fileName: "preview.html", content: f.html, bytes: Buffer.byteLength(f.html) } });
    expect(result.archive.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.preview?.sha256).toBe(createHash("sha256").update(f.html).digest("hex"));
    const archive = join(f.workdir, "result.zip"); await writeFile(archive, bytes);
    const inspected = await execute("python3", ["-c", "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps({n:z.read(n).hex() for n in z.namelist()}))", archive]);
    expect(JSON.parse(inspected.stdout)).toEqual({ "site/index.html": Buffer.from(f.html).toString("hex"), "site/pixel.bin": "00ff010a80" });
    expect((await buildWorkshopArtifact(f.project, "mission", f.sha)).archive).toEqual(result.archive);
  }, 20_000);
  it("ignores Git replacement refs and archive attributes instead of transforming the admitted commit", async () => {
    const f = await fixture();
    await writeFile(join(f.workdir, "site/index.html"), "REPLACEMENT");
    const replaced = await commit(f.workdir);
    await git(f.workdir, "replace", f.sha, replaced);
    await writeFile(join(f.workdir, ".gitattributes"), "site/index.html export-ignore filter=unsafe\n");
    await git(f.workdir, "config", "filter.unsafe.clean", "false");
    expect((await buildWorkshopArtifact(f.project, "mission", f.sha)).preview?.content).toBe(f.html);
  }, 20_000);
  it("honours a narrower trusted export scope and never includes sibling files", async () => {
    const f = await fixture();
    const result = await buildWorkshopArtifact({ ...f.project, exportPaths: ["site/index.html"] }, "mission", f.sha);
    expect(Buffer.from(result.archive.base64, "base64").includes(Buffer.from("pixel.bin"))).toBe(false);
  });
  it("exports ordinary auth source folders without admitting credential files", async () => {
    const f = await fixture();
    await mkdir(join(f.workdir, "src/auth"), {recursive:true}); await mkdir(join(f.workdir, "auth"));
    await writeFile(join(f.workdir, "src/auth/Login.tsx"), "export const Login = () => null;");
    await writeFile(join(f.workdir, "auth/index.ts"), "export const authenticate = () => true;");
    expect(isWorkshopExportPath("auth")).toBe(true);
    expect(isWorkshopExportPath("src/auth/Login.tsx")).toBe(true);
    expect(isWorkshopExportPath("auth/index.ts")).toBe(true);
    const result = await buildWorkshopArtifact({...f.project, allowedPaths:["src","auth"], previewEntry:undefined}, "mission", await commit(f.workdir));
    const archive = join(f.workdir, "auth-sources.zip"); await writeFile(archive, Buffer.from(result.archive.base64,"base64"));
    const inspected = await execute("python3", ["-c", "import json,zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(sorted(z.namelist())))", archive]);
    expect(JSON.parse(inspected.stdout)).toEqual(["auth/index.ts","src/auth/Login.tsx"]);
  });
  it("refuses symlinks rather than following them or placing them in a downloadable archive", async () => {
    const f = await fixture(); await symlink("../private-outside.txt", join(f.workdir, "site/link")); const sha = await commit(f.workdir);
    await expect(buildWorkshopArtifact(f.project, "mission", sha)).rejects.toThrow(/non régulier/);
  });
  it("refuses a gitlink/submodule in the export scope", async () => {
    const f = await fixture();
    await git(f.workdir, "update-index", "--add", "--cacheinfo", "160000", f.sha, "site/submodule");
    await git(f.workdir, "commit", "-qm", "gitlink");
    await expect(buildWorkshopArtifact(f.project, "mission", await git(f.workdir,"rev-parse","HEAD"))).rejects.toThrow(/non régulier/);
  });
  it.each([".env", ".env.production", "private.key", "credentials.json"])("refuses a sensitive file inside the requested tree: %s", async name => {
    const f = await fixture(); await writeFile(join(f.workdir, "site", name), "SECRET"); const sha = await commit(f.workdir);
    await expect(buildWorkshopArtifact(f.project, "mission", sha)).rejects.toThrow(/non admissible/);
  });
  it.each(["../escape", "/etc/passwd", "site/../other", "site\\other", ":(glob)**", "site\nname", ".git/config", "site/.ssh/key", "site/auth.json", "auth.json", ".codex/auth.json", "auth.yaml", "auth.toml", "auth.ini", "auth.conf"])("rejects unsafe export roots: %s", path => {
    expect(isWorkshopExportPath(path)).toBe(false);
  });
  it("rejects nonexistent/noncommit identities and a Git option disguised as a revision", async () => {
    const f = await fixture();
    for (const sha of ["--help", "a".repeat(40), await git(f.workdir, "rev-parse", f.sha + ":site/index.html")]) {
      await expect(buildWorkshopArtifact(f.project, "mission", sha)).rejects.toThrow();
    }
  });
  it("bounds total archive bytes including ZIP headers", async () => {
    const f = await fixture(); await writeFile(join(f.workdir, "site/large.bin"), Buffer.alloc(WORKSHOP_ARCHIVE_MAX_BYTES));
    await expect(buildWorkshopArtifact(f.project, "mission", await commit(f.workdir))).rejects.toThrow(/volumineuse/);
  }, 20_000);
  it("bounds file count before reading any content", async () => {
    const f = await fixture(); await Promise.all(Array.from({length:255}, (_,i) => writeFile(join(f.workdir,"site",`file-${i}`), "x")));
    await expect(buildWorkshopArtifact(f.project, "mission", await commit(f.workdir))).rejects.toThrow(/Nombre/);
  }, 20_000);
  it("keeps binary or oversized HTML as source without pretending it is a supported preview", async () => {
    const f = await fixture();
    for (const bytes of [Buffer.from([0xc0,0xaf]), Buffer.alloc(200*1024+1,65), Buffer.from("<html>\0</html>")]) {
      await writeFile(join(f.workdir,"site/index.html"),bytes);
      const result = await buildWorkshopArtifact(f.project,"mission",await commit(f.workdir));
      expect(result.preview).toBeUndefined(); expect(result.archive.bytes).toBeGreaterThan(bytes.length);
    }
  }, 20_000);
  it("omits an empty HTML preview while preserving the valid source archive", async () => {
    const f = await fixture(); await writeFile(join(f.workdir, "site/index.html"), "");
    const result = await buildWorkshopArtifact(f.project, "mission", await commit(f.workdir));
    expect(result.preview).toBeUndefined();
    const archive = join(f.workdir, "empty-index.zip"); await writeFile(archive, Buffer.from(result.archive.base64, "base64"));
    const inspected = await execute("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('site/index.html') == b''; print(len(z.namelist()))", archive]);
    expect(inspected.stdout.trim()).toBe("2");
  });
  it("does not start export work for an already-aborted request", async () => {
    const f = await fixture(); const abort = new AbortController(); abort.abort();
    await expect(buildWorkshopArtifact(f.project,"mission",f.sha,abort.signal)).rejects.toThrow(/annulée/);
  });
});
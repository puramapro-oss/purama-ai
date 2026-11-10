import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChefProcessStopUnconfirmedError, runChefProcess, type ChefProcessOptions } from "../src/chef/process.js";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "chef-process-"));
  tempDirs.push(cwd);
  return cwd;
}

function options(cwd: string, script: string, overrides: Partial<ChefProcessOptions> = {}): ChefProcessOptions {
  return {
    command: process.execPath, args: ["-e", script], cwd, env: {},
    timeoutMs: 5_000, maxOutputBytes: 1024, label: "fixture",
    abortMessage: "fixture cancelled", timeoutMessage: "fixture timed out",
    terminationGraceMs: 100, terminationConfirmationMs: 500,
    ...overrides,
  };
}

describe.skipIf(process.platform === "win32")("CHEF owned POSIX process group", () => {
  it("preserves ordinary output and exit status", async () => {
    const cwd = await fixture();
    const result = await runChefProcess(options(cwd, "process.stdout.write('ok');process.stderr.write('warning');process.exitCode=7"));
    expect(result).toMatchObject({ stdout: "ok", stderr: "warning", exitCode: 7, signal: null });
    expect(result.output.length).toBe(9);
  });

  it("does not reject cancellation until the direct process has actually closed", async () => {
    const cwd = await fixture();
    const ready = join(cwd, "ready");
    const stopping = join(cwd, "stopping");
    const release = join(cwd, "release");
    const stopped = join(cwd, "stopped");
    const script = `const fs=require('node:fs');
      process.on('SIGTERM',()=>{
        fs.writeFileSync(${JSON.stringify(stopping)},'received');
        setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){
          fs.writeFileSync(${JSON.stringify(stopped)},'closed');process.exit(0);
        }},10);
      });
      fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
    const cancel = new AbortController();
    let settled = false;
    const pending = runChefProcess(options(cwd, script, { signal: cancel.signal, terminationGraceMs: 2_000 }))
      .catch((error: unknown) => { settled = true; return error; });
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3_000 });
      cancel.abort();
      await vi.waitFor(() => expect(existsSync(stopping)).toBe(true));
      expect(settled).toBe(false);
      await writeFile(release, "release");
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(ChefProcessStopUnconfirmedError);
      expect((error as Error).message).toBe("fixture cancelled");
      expect(existsSync(stopped)).toBe(true);
    } finally {
      cancel.abort();
      await pending;
    }
  }, 10_000); // Includes readiness failure and the unchanged 2 s termination grace.

  it("kills a surviving descendant in the owned group after its leader exits", async () => {
    const cwd = await fixture();
    const ready = join(cwd, "descendant-ready");
    const pulse = join(cwd, "pulse");
    const descendant = `const fs=require('node:fs');process.on('SIGTERM',()=>{});
      fs.writeFileSync(${JSON.stringify(ready)},'ready');
      setInterval(()=>fs.writeFileSync(${JSON.stringify(pulse)},String(Date.now())),10);`;
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
      setInterval(()=>{},1000);`;
    const cancel = new AbortController();
    const pending = runChefProcess(options(cwd, script, { signal: cancel.signal })).catch((error: unknown) => error);
    try {
      // Two Node processes must start before the first pulse; allow preparation
      // under suite load without changing the grace or confirmation deadlines.
      await vi.waitFor(() => expect(existsSync(pulse)).toBe(true), { timeout: 3_000 });
      cancel.abort();
      const error = await pending;
      expect(error).toBeInstanceOf(Error);
      // A host that cannot reap orphan zombies may correctly report unconfirmed;
      // either way, cancellation must stop the descendant's observable work.
      const lastPulse = await readFile(pulse, "utf8");
      await delay(100);
      expect(await readFile(pulse, "utf8")).toBe(lastPulse);
    } finally {
      cancel.abort();
      await pending;
    }
  });

  it("reports an unconfirmed stop when the owned group cannot be signalled", async () => {
    const cwd = await fixture();
    const ready = join(cwd, "pid");
    const script = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
    const cancel = new AbortController();
    const pending = runChefProcess(options(cwd, script, {
      signal: cancel.signal, terminationGraceMs: 25, terminationConfirmationMs: 50,
    })).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 3_000 });
      const pid = Number(await readFile(ready, "utf8"));
      const originalKill = process.kill.bind(process);
      const sent: Array<number | string | undefined> = [];
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid) {
          sent.push(signal);
          if (signal !== 0) throw Object.assign(new Error("permission denied"), { code: "EPERM" });
          return true;
        }
        return originalKill(target, signal);
      });
      try {
        cancel.abort();
        const error = await pending;
        expect(error).toBeInstanceOf(ChefProcessStopUnconfirmedError);
        expect((error as Error).message).toContain("arrêt du groupe non confirmé");
        expect(sent).toContain("SIGTERM");
        expect(sent).toContain("SIGKILL");
        expect(kill.mock.calls.every(([target]) => target === -pid)).toBe(true);
      } finally {
        kill.mockRestore();
        try { originalKill(-pid, "SIGKILL"); } catch { /* already gone */ }
        await vi.waitFor(() => {
          expect(() => originalKill(pid, 0)).toThrow();
        });
      }
    } finally {
      cancel.abort();
      await pending;
    }
  });

  it("bounds combined stdout and stderr and stops on overflow", async () => {
    const cwd = await fixture();
    await expect(runChefProcess(options(cwd, "process.stdout.write('a'.repeat(600));process.stderr.write('b'.repeat(600));setInterval(()=>{},1000)")))
      .rejects.toThrow(/trop volumineuse/);
  });
});

import vm from "node:vm";
import http from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "../../karta/node_modules/typescript/lib/typescript.js";

// Read the audited baseline from Git even after index.ts has been repaired.
// The only real connection is an ephemeral HTTP server bound to loopback.
const baseline = "1a49ad646b529c6fb95335105c8a4e5f28468d76";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = execFileSync("git", ["show", `${baseline}:karta/src/index.ts`], {
  cwd: root, encoding: "utf8",
});
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const handlers = {};
const exits = [];
let response;
let drained = false;
let markRequested;
const requested = new Promise(resolve => { markRequested = resolve; });
const server = http.createServer((_req, res) => {
  response = res;
  markRequested();
});
server.on("close", () => { drained = true; });
const dependencies = {
  "./config.js": { config: { mockClaude: true, port: 0 } },
  "./api/server.js": { startApiServer: () => {
    server.listen(0, "127.0.0.1");
    return server;
  } },
  "./queue/worker.js": { startAgentCycleWorker: () => ({ close: async () => {} }) },
  "./scheduler/cron.js": { startSchedulers: () => [{ stop: () => {} }] },
  "./scheduler/customAgents.js": { startCustomAgentScheduler: () => ({ stop: () => {} }) },
};

try {
  vm.runInNewContext(code, {
    exports: {}, require: id => dependencies[id], console: { log() {} },
    process: {
      on: (event, fn) => { handlers[event] = fn; },
      exit: exitCode => exits.push({
        exitCode, httpDrained: drained, requestFinished: response?.writableFinished,
      }),
    },
  });
  await once(server, "listening");
  const request = fetch(`http://127.0.0.1:${server.address().port}/inert`);
  await requested;
  handlers.SIGTERM();
  await new Promise(resolve => setImmediate(resolve));
  const reproduced = exits.some(exit => exit.exitCode === 0 && !exit.httpDrained && !exit.requestFinished);
  console.log(JSON.stringify({
    baseline, source: "karta/src/index.ts",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    scenario: "real loopback HTTP request remains open when baseline calls process.exit(0)",
    reproduced, exits,
    limits: "Worker and schedulers are inert doubles; no Redis, Supabase or external provider.",
  }, null, 2));
  response.end("inert completed");
  await (await request).text();
  if (!reproduced) process.exitCode = 1;
} finally {
  response?.end();
  server.closeAllConnections();
  if (server.listening) server.close();
  if (!drained) await once(server, "close");
}

import "dotenv/config";
import { parseWorkshopProjects } from "./workshop-config.js";
import { checkWorkshopRuntime, runWorkshopRuntime, WorkshopRuntimeError } from "./workshop-runtime.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new WorkshopRuntimeError("WORKSHOP_CONFIG");
  }
  const stop = new AbortController();
  const onStop = () => stop.abort();
  process.once("SIGINT", onStop);
  process.once("SIGTERM", onStop);
  try {
    const projects = parseWorkshopProjects();
    if (args[0] === "--check") {
      const result = await checkWorkshopRuntime(projects, stop.signal);
      console.info("[chef-workshop] PASS : " + result.projectCount + " projet(s) vérifié(s), aucun agent démarré.");
    } else {
      await runWorkshopRuntime(projects, stop.signal);
    }
  } finally {
    process.removeListener("SIGINT", onStop);
    process.removeListener("SIGTERM", onStop);
  }
}

void main().catch(error => {
  const code = error instanceof WorkshopRuntimeError ? error.code : "WORKSHOP_CONFIG";
  const message = error instanceof WorkshopRuntimeError ? error.message : "Configuration atelier invalide.";
  console.error("[chef-workshop] " + code + " : " + message);
  process.exitCode = code === "WORKSHOP_PROCESS_STOP" ? 3 : 1;
});

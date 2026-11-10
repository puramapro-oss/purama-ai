type Handler = (request: Request) => Response | Promise<Response>;
let captured: Handler | undefined;

// Capture the real edge entry point without opening a socket or contacting a service.
export function serve(handler: Handler): void { captured = handler; }
// Replace only server registration inside this isolated test worker.
Object.defineProperty(Deno, "serve", { value: serve });
export function getHandler(): Handler {
  if (!captured) throw new Error('Edge handler was not registered');
  return captured;
}

export type Handler = (request: Request) => Response | Promise<Response>;
let current: Handler | undefined;
export function serve(handler: Handler) {
  current = handler;
}
export function handler(): Handler {
  if (!current) throw new Error("Handler was not registered");
  return current;
}

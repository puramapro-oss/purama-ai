import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyPhoneCommandToken } from "./commands.js";
import { createPhoneProvider, verifyPhoneWebhook, type PhoneProvider } from "./phone.js";
import { routineRuntimeConfig, type RoutineRuntimeConfig } from "./runtime.js";
import { routineMayDeliverAt } from "./schedule.js";
import { record, routineId, routineStore, RoutineError, type RoutineStore } from "./store.js";

function parse(raw: Buffer): Record<string, unknown> {
  if (raw.length > 65_536) throw new RoutineError("ROUTINE_BODY_TOO_LARGE", 413, "Requête trop volumineuse.");
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    if (record(value)) return value;
  } catch { /* Return the same bounded public error. */ }
  throw new RoutineError("ROUTINE_INVALID", 400, "Requête invalide.");
}
function secretMatches(authorization: unknown, secret: string): boolean {
  if (secret.length < 32 || typeof authorization !== "string" || authorization.length > 8192) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(authorization), hash(`Bearer ${secret}`));
}
const unavailable = () => new RoutineError("ROUTINE_PHONE_CONTEXT_INVALID", 403, "Le contexte de cet appel ne permet pas cette action.");

export function createRoutinePhoneHandlers(deps: {
  store?: RoutineStore; runtime?: RoutineRuntimeConfig; phone?: PhoneProvider; now?: () => number;
} = {}) {
  const store = deps.store ?? routineStore;
  const runtime = deps.runtime ?? routineRuntimeConfig();
  const phone = deps.phone ?? createPhoneProvider(runtime.phone);
  const now = deps.now ?? Date.now;
  return {
    async webhook(raw: Buffer, signature: string | undefined) {
      if (!verifyPhoneWebhook(raw, signature, runtime.phone.webhookSecret)) throw unavailable();
      const body = parse(raw);
      const callId = routineId(body.call_id);
      const occurrenceId = routineId(body.external_id);
      const occurrence = await store.occurrenceById(occurrenceId);
      if (!occurrence) throw unavailable();
      const delivery = (await store.deliveries(occurrence)).find(item => item.channel === "call");
      if (!delivery || (delivery.providerId && delivery.providerId !== callId)
        || !["sending", "accepted", "unknown", "completed", "failed"].includes(delivery.status)) throw unavailable();
      // A signed body may be replayed. Only the current provider record may
      // advance the durable receipt; transcripts are never interpreted here.
      const receipt = await phone.lookupPhoneCall(callId);
      if (receipt.externalId !== occurrence.id || receipt.callId !== callId) throw unavailable();
      let updated = false;
      if (receipt.status !== "unknown") updated = await store.finish(occurrence, "call", receipt.status, callId,
        { answeredBy: receipt.answeredBy ?? "unknown", heardConfirmed: false, reconciled: true });
      await store.refresh(occurrence);
      return { ok: true, updated };
    },
    async command(raw: Buffer, authorization: string | undefined, isActive = () => true) {
      if (!secretMatches(authorization, runtime.commandSecret) || !runtime.enabled || !runtime.phone.enabled || !isActive()) throw unavailable();
      const body = parse(raw);
      const allowed = ["call_id", "occurrence_id", "token", "expires_at", "instruction"];
      if (Object.keys(body).some(key => !allowed.includes(key)) || Object.keys(body).length !== allowed.length
        || typeof body.instruction !== "string" || [...body.instruction.trim()].length < 1 || [...body.instruction].length > 4000
        // eslint-disable-next-line no-control-regex -- Explicitly reject unsafe control characters in the spoken instruction.
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]|[\ud800-\udfff]/u.test(body.instruction)) throw unavailable();
      const callId = routineId(body.call_id);
      const occurrence = await store.occurrenceById(routineId(body.occurrence_id));
      if (!occurrence || !verifyPhoneCommandToken(runtime.commandSecret, occurrence, body.expires_at, body.token, now())
        || ["cancelled", "skipped", "failed"].includes(occurrence.status) || !isActive()) throw unavailable();
      const routine = await store.get(occurrence.userId, occurrence.routineId);
      if (routine.revision !== occurrence.revision || !routineMayDeliverAt(routine.config, now())
        || !await store.globalAllowed() || !isActive()) throw unavailable();
      const delivery = (await store.deliveries(occurrence)).find(item => item.channel === "call");
      if (!delivery || !["sending", "accepted", "unknown"].includes(delivery.status)
        || (delivery.providerId && delivery.providerId !== callId)) throw unavailable();
      // This also resolves a command racing the outbound POST acknowledgement.
      const receipt = await phone.lookupPhoneCall(callId);
      if (receipt.callId !== callId || receipt.externalId !== occurrence.id || receipt.status !== "accepted" || !isActive()) throw unavailable();
      if (!delivery.providerId && !await store.finish(occurrence, "call", "accepted", callId, { heardConfirmed: false })) throw unavailable();
      // Re-read consent after the potentially slow provider lookup. The SQL
      // command RPC performs its own locked consent check at insertion time.
      const latest = await store.get(occurrence.userId, occurrence.routineId);
      if (latest.revision !== occurrence.revision || !routineMayDeliverAt(latest.config, now()) || !isActive()
        || !verifyPhoneCommandToken(runtime.commandSecret, occurrence, body.expires_at, body.token, now())) throw unavailable();
      const instruction = body.instruction.trim().normalize("NFC");
      // The provider's model chooses only the requested instruction, never an
      // execution identity. Repeating the same request within this call is safe.
      const requestKey = createHash("sha256").update(JSON.stringify([callId, instruction])).digest("hex");
      const command = await store.recordCommand(occurrence, requestKey, instruction);
      if (!record(command) || command.user_id !== occurrence.userId || command.occurrence_id !== occurrence.id
        || command.status !== "pending_confirmation") throw new RoutineError("ROUTINE_COMMAND_UNCONFIRMED");
      return { ok: true, command: { id: routineId(command.id), status: "pending_confirmation" },
        message: "Demande enregistrée. Confirmez-la dans IAO pour la reprendre ; aucune tâche n’a encore été exécutée." };
    },
  };
}

async function rawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of req) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > 65_536) throw new RoutineError("ROUTINE_BODY_TOO_LARGE", 413, "Requête trop volumineuse.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function handleRoutinePhoneRoute(req: IncomingMessage, res: ServerResponse, url: URL,
  isActive: () => boolean): Promise<boolean> {
  if (!/^\/routines\/phone\/(webhook|command)$/.test(url.pathname)) return false;
  res.setHeader("Cache-Control", "no-store");
  let status = 200; let response: unknown;
  try {
    if (req.method !== "POST" || url.search) throw new RoutineError("ROUTINE_INVALID", 400, "Requête invalide.");
    const handlers = createRoutinePhoneHandlers();
    const raw = await rawBody(req);
    const signature = req.headers["x-webhook-signature"];
    response = url.pathname.endsWith("/webhook")
      ? await handlers.webhook(raw, typeof signature === "string" ? signature : undefined)
      : await handlers.command(raw, req.headers.authorization, isActive);
  } catch (error) {
    status = error instanceof RoutineError ? error.status : 503;
    response = { ok: false, code: error instanceof RoutineError ? error.code : "ROUTINE_UNAVAILABLE",
      error: error instanceof RoutineError ? error.message : "Le résultat de cette demande n’est pas confirmé." };
  }
  if (!res.destroyed && !res.headersSent) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(response)); }
  return true;
}

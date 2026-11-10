import {
  assertEntraideRateLimit, entraideErrorResponse, EntraideHttpError,
  entraideJson, entraideRouteParts, readEntraideJson,
} from "../_shared/entraide-http.ts";

export const missionsCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type DatabaseError = { code?: string; message?: string };
type DatabaseResult<T> = { data: T | null; error: DatabaseError | null };
export type MissionCommand = {
  p_request_id: string;
  p_action: string;
  p_mission_id: string | null;
  p_payload: Record<string, unknown>;
  p_expected_version: number | null;
};
export interface MissionsBackend {
  getUserId(): Promise<string | null>;
  listMissions(): Promise<DatabaseResult<unknown[]>>;
  mutateMission(command: MissionCommand): Promise<DatabaseResult<{ mission: unknown; replayed: boolean }>>;
}
export interface MissionsDependencies {
  createBackend(authorization: string): MissionsBackend;
  limit?: typeof assertEntraideRateLimit;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions = new Set(["join", "leave", "start", "complete", "cancel"]);
const failures: Record<string, [number, string]> = {
  auth_required: [401, "Connectez-vous pour continuer."],
  invalid_request: [400, "La demande contient des données invalides."],
  organizer_required: [403, "Cette commande est réservée à l’organisateur."],
  mission_not_found: [404, "Cette mission est introuvable."],
  stale_mission: [409, "La mission a changé. Consultez son état actualisé avant de décider."],
  request_id_conflict: [409, "Cet identifiant de demande a déjà servi pour une autre action."],
  mission_not_recruiting: [409, "Cette mission n’accepte plus d’inscription."],
  already_joined: [409, "Vous participez déjà à cette mission."],
  mission_full: [409, "La dernière place a déjà été prise."],
  not_a_participant: [409, "Vous ne participez pas à cette mission."],
  mission_closed: [409, "Cette mission est clôturée."],
  not_ready: [409, "Le nombre de participants ne permet pas encore de démarrer."],
  not_in_progress: [409, "Cette mission n’est pas en cours."],
  already_closed: [409, "Cette mission est déjà clôturée."],
};

function fail(code: string): never {
  const [status, message] = failures[code] ?? [500, "La demande n’a pas pu être traitée."];
  throw new EntraideHttpError(status, failures[code] ? code : "internal_error", message);
}

function checkedResult<T>(result: DatabaseResult<T>): T {
  if (result.error) {
    if (result.error.code === "P0001" && result.error.message && failures[result.error.message]) {
      fail(result.error.message);
    }
    fail("internal_error");
  }
  if (result.data === null) fail("internal_error");
  return result.data;
}

function objectBody(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_request");
  if (Object.keys(body).some((key) => !allowed.includes(key))) fail("invalid_request");
  return body as Record<string, unknown>;
}

function requestId(body: Record<string, unknown>): string {
  if (typeof body.request_id !== "string" || !uuid.test(body.request_id)) fail("invalid_request");
  return body.request_id;
}

function createCommand(body: unknown): MissionCommand {
  const b = objectBody(body, ["request_id", "title", "description", "min_participants", "max_participants"]);
  const id = requestId(b);
  if (typeof b.title !== "string" || b.title.trim().length < 1 || b.title.trim().length > 200
    || typeof b.description !== "string" || b.description.length > 2000
    || !Number.isInteger(b.min_participants) || (b.min_participants as number) < 2
    || (b.min_participants as number) > 2147483647) fail("invalid_request");
  const max = b.max_participants ?? null;
  if (max !== null && (!Number.isInteger(max) || (max as number) < (b.min_participants as number)
    || (max as number) > 2147483647)) fail("invalid_request");
  return {
    p_request_id: id, p_action: "create", p_mission_id: null, p_expected_version: null,
    p_payload: { title: b.title.trim(), description: b.description,
      min_participants: b.min_participants, max_participants: max },
  };
}

function actionCommand(body: unknown, missionId: string, action: string): MissionCommand {
  const b = objectBody(body, ["request_id", "expected_version"]);
  const id = requestId(b);
  const expected = b.expected_version ?? null;
  if ((["start", "complete", "cancel"].includes(action) && expected === null)
    || (expected !== null && (!Number.isSafeInteger(expected) || (expected as number) < 1))) {
    fail("invalid_request");
  }
  return { p_request_id: id, p_action: action, p_mission_id: missionId,
    p_payload: {}, p_expected_version: expected as number | null };
}

/** Le transport authentifie ; la RPC vérifie les droits et écrit dans une seule transaction. */
export function createMissionsHandler(dependencies: MissionsDependencies) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: missionsCors });
    try {
      if (req.method !== "GET" && req.method !== "POST") {
        throw new EntraideHttpError(405, "method_not_allowed", "Méthode non prise en charge.", { Allow: "GET, POST, OPTIONS" });
      }
      const parts = entraideRouteParts(req, "entraide-missions");
      if (parts.length !== 0 && (parts.length !== 2 || req.method !== "POST"
        || !uuid.test(parts[0]) || !actions.has(parts[1]))) {
        throw new EntraideHttpError(404, "route_not_found", "Cette adresse est introuvable.");
      }
      const authorization = req.headers.get("Authorization");
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) fail("auth_required");
      const backend = dependencies.createBackend(authorization);
      const userId = await backend.getUserId();
      if (!userId) fail("auth_required");
      const limit = dependencies.limit ?? assertEntraideRateLimit;

      if (req.method === "GET") {
        limit(userId, "missions-list", 60);
        return entraideJson({ missions: checkedResult(await backend.listMissions()) }, 200, missionsCors);
      }
      const action = parts[1] ?? "create";
      limit(userId, `mission-${action}`, action === "create" ? 10 : 20);
      const body = await readEntraideJson(req);
      const command = action === "create" ? createCommand(body) : actionCommand(body, parts[0], action);
      const data = checkedResult(await backend.mutateMission(command));
      return entraideJson(data, action === "create" && !data.replayed ? 201 : 200, missionsCors);
    } catch (error) {
      return entraideErrorResponse(error, missionsCors);
    }
  };
}

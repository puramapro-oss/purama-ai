import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getUserById: vi.fn(),
  config: { supabaseUrl: "https://example.invalid", supabaseServiceRoleKey: "test-key", resendApiKey: "test-resend", resendFromEmail: "noreply@example.com", notificationTimeoutMs: 5_000 },
}));
vi.mock("../src/config.js", () => ({ config: mocks.config }));
vi.mock("../src/db/supabase.js", () => ({ supabase: { auth: { admin: { getUserById: mocks.getUserById } } } }));
import { notify, type NotifyInput } from "../src/engine/notify.js";

const input: NotifyInput = { userId: "u1", agentType: "legal", title: "Avis", body: "Texte", channels: ["in_app"] };
const accepted = { ok: true, notification_id: "n1", push_sent: 1, push_failed: 0 };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.config.resendApiKey = "test-resend";
  mocks.getUserById.mockResolvedValue({ data: { user: { email: "user@example.com" } }, error: null });
  mocks.fetch.mockRejectedValue(new Error("unexpected network request"));
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("confirmation des notifications", () => {
  it("confirme l'enregistrement in-app et ne demande pas un email non souhaité", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(accepted));
    await expect(notify(input)).resolves.toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it.each([{}, null, [], { ok: false, notification_id: "n1" }, { ok: true, notification_id: " " }, { ...accepted, error: "denied" }])("refuse un accusé de notification invalide : %j", async (body) => {
    mocks.fetch.mockResolvedValueOnce(reply(body));
    await expect(notify({ ...input, channels: ["in_app", "email"] })).rejects.toThrow("non confirmé");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it("signale une configuration email absente après l'enregistrement sans le répéter", async () => {
    mocks.config.resendApiKey = "";
    mocks.fetch.mockResolvedValueOnce(reply(accepted));
    await expect(notify({ ...input, channels: ["in_app", "email"] })).rejects.toThrow("email demandé non envoyé");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([{ data: { user: null }, error: null }, { data: { user: null }, error: { message: "private auth detail" } }])("signale un destinataire non confirmé", async (result) => {
    mocks.fetch.mockResolvedValueOnce(reply(accepted));
    mocks.getUserById.mockResolvedValueOnce(result);
    await expect(notify({ ...input, channels: ["in_app", "email"] })).rejects.toThrow("destinataire email non confirmé");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("signale un refus Resend sans inclure son contenu sensible dans l'erreur", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(accepted)).mockResolvedValueOnce(reply({ error: "sensitive payload" }, 429));
    await expect(notify({ ...input, channels: ["in_app", "email"] })).rejects.toThrow(/^notify: notification enregistrée mais Resend a répondu 429$/);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { id: 42 }, { id: " " }, { error: "provider failure" }, { id: "email-1", error: { message: "denied" } }])("ne considère pas HTTP 200 seul comme confirmation email : %j", async (body) => {
    mocks.fetch.mockResolvedValueOnce(reply(accepted)).mockResolvedValueOnce(reply(body));
    await expect(notify({ ...input, channels: ["in_app", "email"] })).rejects.toThrow("acceptation de l'email non confirmée");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ push_sent: 0 }, { push_sent: -1 }, { push_sent: "1" }, { push_failed: 1 }, { push_failed: undefined }])("signale un push non confirmé mais tente encore l'email demandé : %j", async (override) => {
    mocks.fetch.mockResolvedValueOnce(reply({ ...accepted, ...override })).mockResolvedValueOnce(reply({ id: "email-1" }));
    await expect(notify({ ...input, channels: ["in_app", "push", "email"] })).rejects.toThrow("push non confirmé");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it("envoie le contenu non fiable comme texte et confirme seulement les accusés fournisseurs", async () => {
    const body = '<img src="https://example.invalid/tracker"> & "texte"';
    mocks.fetch.mockResolvedValueOnce(reply(accepted)).mockResolvedValueOnce(reply({ id: "email-1" }));
    await expect(notify({ ...input, body, channels: ["in_app", "push", "email"] })).resolves.toBeUndefined();
    const request = JSON.parse(mocks.fetch.mock.calls[1][1].body);
    expect(request.text).toBe(body);
    expect(request).not.toHaveProperty("html");
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ guard: vi.fn(), quota: vi.fn(), signals: [] as AbortSignal[] }));
vi.mock("../src/lib/gmail-token-crypto.js", () => ({
  decryptGmailToken: (value: string) => value, encryptGmailToken: (value: string) => value,
}));
vi.mock("../src/config.js", () => ({ config: {} }));
vi.mock("../src/db/supabase.js", () => ({ supabase: {
  rpc: (name: string, params: Record<string, unknown>) => {
    const request = name === "partner_direct_send_guard" ? h.guard(params)
      : name === "karta_reserve_daily_counter" ? h.quota(params)
        : Promise.reject(new Error("Unexpected RPC"));
    return Object.assign(request, { abortSignal: (signal: AbortSignal) => { h.signals.push(signal); return request; } });
  },
  from: () => ({
    select() { return this; }, eq() { return this; }, abortSignal() { return this; },
    async maybeSingle() { return { data: { gmail_refresh_token: "fixture-refresh", gmail_access_token: "fixture-access",
      gmail_token_expiry: new Date(Date.now() + 3_600_000).toISOString() }, error: null }; },
  }),
} }));

const { gmailSendTool } = await import("../src/tools/gmail.js");
const allowed = { data: { status: "allowed", reason: null }, error: null };
const blocked = { data: { status: "blocked", reason: "partner_reply_preparation_required" }, error: null };
const input = { to: "contact@example.test", subject: "Question", body: "Texte de réponse" };
const reply = { ...input, threadId: "thread-1", replyToMessageId: "parent-1" };
const custom = { userId: "fixture-user", agentType: "custom:standalone-mail" as const, mode: "live" as const };
let send: ReturnType<typeof vi.fn>;
const posts = () => send.mock.calls.filter(([, init]) => init?.method === "POST");

beforeEach(() => {
  h.guard.mockReset().mockResolvedValue(allowed);
  h.quota.mockReset().mockResolvedValue({ data: 1, error: null });
  h.signals.length = 0;
  send = vi.fn(async (url: string) => {
    if (url.includes("/messages/parent-1?")) return Response.json({ id: "parent-1", threadId: "thread-1", payload: {
      mimeType: "text/plain", body: { size: 7, data: Buffer.from("Bonjour").toString("base64url") },
      headers: [{ name: "From", value: input.to }, { name: "Subject", value: input.subject },
        { name: "Message-ID", value: "<parent@example.test>" }],
    } });
    if (url.endsWith("/messages/send")) return Response.json({ id: "sent-1" });
    throw new Error("Unexpected provider request");
  });
  vi.stubGlobal("fetch", send);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("shared KARTA Gmail partner guard", () => {
  it.each([
    ["Facture", "Je conteste les 24 € facturés en supplément."],
    ["Facture", "Les pièces de mon dossier font apparaître un écart de 30,00 €. Je vous demande de vérifier cette ligne et de corriger la facture. Merci de me confirmer la suite donnée."],
    ["Contestation de la facture de 120 EUR", "Je joins le devis."],
    ["Régularisation", "Je sollicite le remboursement de 80,50 euros."],
    ["Débit", "Remboursez-moi cinquante euros."],
    ["Invoice", "I dispute the £24.50 charge."],
    ["Échéancier", "Nous acceptons votre proposition d’échelonnement."],
    ["Réponse", "Bon pour accord."],
    ["Paiement", "Je reconnais vous devoir cette somme."],
    ["Confirmation", "I acknowledge that I owe you this debt."],
    ["Agreement", "We accept your settlement offer."],
  ])("prepares explicit commitments for human review in Gmail: %s / %s", async (subject, body) => {
    const context = { ...custom, operationId: "claimed-by-caller", requiresApproval: false };
    await expect(gmailSendTool.execute({ ...input, subject, body }, context)).rejects.toThrow(/brouillon.*Gmail/i);
    expect(h.quota).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "Pouvez-vous me transmettre le détail de cette facture de 24 € ?",
    "Pouvez-vous me transmettre le détail de la ligne de 30,00 € et le justificatif d’acceptation correspondant ?",
    "Pouvez-vous me préciser la date de remboursement des 24 € annoncés ?",
    "Je vous confirme le rendez-vous de lundi.",
    "Pouvons-nous discuter de votre proposition de règlement ?",
    "Could you send me a copy of the £24 invoice?",
  ])("keeps factual correspondence available: %s", async body => {
    await expect(gmailSendTool.execute({ ...input, body }, custom)).resolves.toEqual({ messageId: "sent-1" });
    expect(posts()).toHaveLength(1);
  });

  it("keeps an ordinary standalone email and checks the exact account and recipient twice", async () => {
    await expect(gmailSendTool.execute(input, custom)).resolves.toEqual({ messageId: "sent-1" });
    expect(h.guard).toHaveBeenCalledTimes(2);
    expect(h.guard).toHaveBeenNthCalledWith(1, { p_user_id: custom.userId, p_recipient: input.to,
      p_parent_gmail_id: null, p_gmail_thread_id: null });
    expect(h.quota).toHaveBeenCalledOnce();
    expect(h.guard.mock.invocationCallOrder[0]).toBeLessThan(h.quota.mock.invocationCallOrder[0]);
    expect(h.quota.mock.invocationCallOrder[0]).toBeLessThan(h.guard.mock.invocationCallOrder[1]);
    expect(h.guard.mock.invocationCallOrder[1]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(posts()).toHaveLength(1);
  });

  it.each(["email", "repondeur-intelligent", "custom:standalone-mail"] as const)(
    "blocks a known partner for %s before reserving quota or sending", async agentType => {
      h.guard.mockResolvedValue(blocked);
      await expect(gmailSendTool.execute(reply, { ...custom, agentType })).rejects.toThrow(/Partenariats.*approuver.*Emails/);
      expect(h.guard).toHaveBeenCalledExactlyOnceWith({ p_user_id: custom.userId, p_recipient: input.to,
        p_parent_gmail_id: reply.replyToMessageId, p_gmail_thread_id: reply.threadId });
      expect(h.quota).not.toHaveBeenCalled();
      expect(posts()).toHaveLength(0);
    },
  );

  it("blocks an omitted parent too when a standalone recipient is a partner", async () => {
    h.guard.mockResolvedValue(blocked);
    await expect(gmailSendTool.execute(input, custom)).rejects.toThrow(/Échange partenaire/);
    expect(h.quota).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("honours a contact exclusion without redirecting it toward another sending path", async () => {
    h.guard.mockResolvedValue({ data: { status: "blocked", reason: "contact_suppressed" }, error: null });
    await expect(gmailSendTool.execute(input, custom)).rejects.toThrow(/Contact exclu.*aucun envoi Gmail autorisé/);
    expect(h.quota).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("stops when partner evidence appears during the quota reservation", async () => {
    h.guard.mockResolvedValueOnce(allowed).mockResolvedValueOnce(blocked);
    await expect(gmailSendTool.execute(input, custom)).rejects.toThrow(/Échange partenaire/);
    expect(h.quota).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(h.guard).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing migration", { data: null, error: { message: "function missing" } }],
    ["absent result", { data: null, error: null }],
    ["scalar result", { data: true, error: null }],
    ["array result", { data: [allowed.data], error: null }],
    ["unknown status", { data: { status: "unknown", reason: null }, error: null }],
    ["missing reason", { data: { status: "allowed" }, error: null }],
    ["contradictory result", { data: { status: "allowed", reason: "partner_reply_preparation_required" }, error: null }],
    ["invalid identity", { data: { status: "blocked", reason: "invalid_send_identity" }, error: null }],
  ])("fails closed for %s without quota or provider POST", async (_label, response) => {
    h.guard.mockResolvedValue(response);
    await expect(gmailSendTool.execute(input, custom)).rejects.toThrow(/aucun envoi Gmail autorisé/);
    expect(h.quota).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("fails closed if the final guard becomes unavailable", async () => {
    h.guard.mockResolvedValueOnce(allowed).mockResolvedValueOnce({ data: null, error: { message: "storage unavailable" } });
    await expect(gmailSendTool.execute(input, custom)).rejects.toThrow(/indisponible.*aucun envoi/);
    expect(h.quota).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([1, 2])("does not accept a late result from guard %i", async stage => {
    vi.useFakeTimers();
    let resolve!: (value: typeof allowed) => void;
    const late = new Promise<typeof allowed>(done => { resolve = done; });
    if (stage === 2) h.guard.mockResolvedValueOnce(allowed);
    h.guard.mockImplementationOnce(() => late);
    let settled = false;
    const outcome = gmailSendTool.execute(input, custom).then(() => null, error => error as Error)
      .then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(40_001);
    try {
      expect(settled).toBe(true);
      expect((await outcome)?.message).toMatch(/Délai/);
      expect(h.quota).toHaveBeenCalledTimes(stage - 1);
      expect(send).not.toHaveBeenCalled();
      expect(new Set(h.signals).size).toBe(1);
      expect(h.signals[0].aborted).toBe(true);
    } finally { resolve(allowed); }
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
  });
});

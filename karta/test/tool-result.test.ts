import { describe, expect, it } from "vitest";
import {
  assertToolResult,
  summarizeToolResult,
  withTimeout,
  withToolTimeout,
  ToolResultError,
  ToolTimeoutError,
  TimeoutError,
  TOOL_TIMEOUT_MS,
} from "../src/engine/tool-result.js";

describe("assertToolResult — contrat strict des résultats d'outils (P0 2026-09-26)", () => {
  it("laisse passer undefined/null (void légitime d'un outil Promise<void>)", () => {
    expect(() => assertToolResult(undefined)).not.toThrow();
    expect(() => assertToolResult(null)).not.toThrow();
  });

  it("rejette false (échec implicite strict)", () => {
    expect(() => assertToolResult(false)).toThrow(ToolResultError);
    expect(() => assertToolResult(false)).toThrow(/false/);
  });

  it("laisse passer true et toute donnée brute non-objet", () => {
    expect(() => assertToolResult(true)).not.toThrow();
    expect(() => assertToolResult(42)).not.toThrow();
    expect(() => assertToolResult("ok")).not.toThrow();
    expect(() => assertToolResult([])).not.toThrow();
    expect(() => assertToolResult([{ id: 1 }])).not.toThrow();
  });

  it("rejette les enveloppes d'échec explicites ok:false / success:false, avec le message extrait", () => {
    expect(() => assertToolResult({ ok: false })).toThrow(ToolResultError);
    expect(() => assertToolResult({ success: false, message: "envoi refusé" })).toThrow(/envoi refusé/);
    expect(() => assertToolResult({ ok: false, error: "quota dépassé" })).toThrow(/quota dépassé/);
  });

  it("laisse passer les envelopnes de succès explicites ok:true / success:true", () => {
    expect(() => assertToolResult({ ok: true })).not.toThrow();
    expect(() => assertToolResult({ success: true, data: [] })).not.toThrow();
  });

  it("ok:true fait autorité même si un champ error est présent (pas de rejet)", () => {
    expect(() => assertToolResult({ ok: true, error: null })).not.toThrow();
  });

  it("rejette les enveloppes implicites : error chaîne non vide, ou status 'error'", () => {
    expect(() => assertToolResult({ error: "Gmail 500" })).toThrow(/Gmail 500/);
    expect(() => assertToolResult({ status: "error", detail: "timeout upstream" })).toThrow(/timeout upstream/);
    expect(() => assertToolResult({ status: "error" })).toThrow(/status.*error/i);
  });

  it("ne rejette PAS un champ error vide ni un status neutre (données légitimes)", () => {
    expect(() => assertToolResult({ error: "" })).not.toThrow();
    expect(() => assertToolResult({ error: null })).not.toThrow();
    expect(() => assertToolResult({ status: "partial", rows: 3 })).not.toThrow();
  });

  it("l'erreur levée porte la valeur brute pour diagnostic", () => {
    try {
      assertToolResult({ ok: false, sent: 0 });
      expect.unreachable("devait lever");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolResultError);
      expect((e as ToolResultError).result).toEqual({ ok: false, sent: 0 });
    }
  });

  // — Fuzz C19 (reliability lab 2026-09-27) : direction FAUX ÉCHEC uniquement (une valeur
  // exotique ne doit JAMAIS lever) ; la direction faux-succès est couverte par les tests
  // dédiés ci-dessus. Chaque ligne épingle une classe ambiguë du contrat donnée-vs-signal.
  it.each`
    value                        | classe
    ${0}                         | ${"nombre zéro (donnée brute)"}
    ${-1}                        | ${"nombre négatif (donnée brute)"}
    ${""}                        | ${"chaîne vide (donnée brute)"}
    ${NaN}                       | ${"NaN (donnée brute)"}
    ${Infinity}                  | ${"Infinity (donnée brute)"}
    ${new Date(0)}               | ${"Date (passe isPlainObject, aucune clé d'enveloppe)"}
    ${{}}                        | ${"objet vide — aucun signal d'échec, succès silencieux assumé"}
    ${{ ok: "false" }}           | ${"ok:'false' STRING — strict ===false ne matche pas : donnée, succès"}
    ${{ nested: { ok: false } }} | ${"enveloppe d'échec NICHÉE — inspection top-level only : donnée opaque, succès"}
    ${{ success: "error" }}      | ${"success:'error' string ≠ false explicite : succès"}
  `("fuzz $classe → ne lève jamais", ({ value }: { value: unknown }) => {
    expect(() => assertToolResult(value)).not.toThrow();
  });
});

describe("summarizeToolResult — ne lève jamais, résume en ≤200 caractères", () => {
  it("résultats vides", () => {
    expect(summarizeToolResult(undefined)).toBe("ok (sans résultat)");
    expect(summarizeToolResult(null)).toBe("ok (sans résultat)");
  });

  it("chaîne courte passée telle quelle, longue tronquée", () => {
    expect(summarizeToolResult("brouillon créé")).toBe("brouillon créé");
    const long = "x".repeat(500);
    expect(summarizeToolResult(long)).toHaveLength(200);
  });

  it("objet sérialisé puis tronqué", () => {
    expect(summarizeToolResult({ id: 1 })).toBe('{"id":1}');
    const big = { blob: "y".repeat(600) };
    expect(summarizeToolResult(big)).toHaveLength(200);
  });

  it("objet circulaire → fallback sans lever", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(summarizeToolResult(cyclic)).toBe("ok (résultat non sérialisable)");
  });

  it("JSON.stringify qui lève (getter piégé) → fallback sans lever", () => {
    const trapped = {
      get evil(): string {
        throw new Error("boom");
      },
    };
    expect(summarizeToolResult(trapped)).toBe("ok (résultat non sérialisable)");
  });
});

describe("withToolTimeout — borne l'exécution d'un outil dans le temps", () => {
  it("laisse passer une promesse qui résout à temps", async () => {
    await expect(withToolTimeout(Promise.resolve(7), "fast_tool", 1_000)).resolves.toBe(7);
  });

  it("rejette en ToolTimeoutError une promesse qui pend, sans attendre le défaut 30s", async () => {
    const hanging = new Promise<never>(() => {});
    await expect(withToolTimeout(hanging, "hang_tool", 25)).rejects.toThrow(ToolTimeoutError);
  });

  it("le message d'erreur porte le nom de l'outil et le timeout", async () => {
    const hanging = new Promise<never>(() => {});
    await expect(withToolTimeout(hanging, "gmail_send", 25)).rejects.toThrow(/gmail_send.*25ms/);
  });

  it("délai par défaut = TOOL_TIMEOUT_MS (30s)", () => {
    expect(TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it("propage le rejet d'origine si l'outil échoue AVANT le timeout", async () => {
    const failing = Promise.reject(new Error("connexion perdue"));
    await expect(withToolTimeout(failing, "net_tool", 5_000)).rejects.toThrow("connexion perdue");
  });

  it("le timer du timeout ne fait pas échouer la promesse après résolution (pas de rejection non gérée)", async () => {
    const p = withToolTimeout(Promise.resolve("ok"), "tool", 5);
    await p;
    // Laisse le timer expirer : s'il rejetait encore la promesse racing, vitest rattraperait
    // une unhandled rejection et ferait échouer ce fichier.
    await new Promise((r) => setTimeout(r, 20));
    expect(true).toBe(true);
  });
});

describe("withTimeout — variante générique (sert aussi decide(), hors domaine outil)", () => {
  it("rejette en TimeoutError (pas ToolResultError : ce n'est pas un résultat d'outil)", async () => {
    const hanging = new Promise<never>(() => {});
    const err = await withTimeout(hanging, "decide(email)", 20, (label, ms) => new TimeoutError(label, ms)).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolResultError);
    expect((err as TimeoutError).message).toContain("decide(email)");
  });

  it("laisse passer la promesse qui résout à temps et propage son rejet sinon", async () => {
    await expect(withTimeout(Promise.resolve("v"), "op", 1_000, (l, m) => new TimeoutError(l, m))).resolves.toBe("v");
    await expect(
      withTimeout(Promise.reject(new Error("ko")), "op", 1_000, (l, m) => new TimeoutError(l, m))
    ).rejects.toThrow("ko");
  });
});

describe("hiérarchie des erreurs", () => {
  it("ToolTimeoutError est un ToolResultError (même chemin de catch)", () => {
    const err = new ToolTimeoutError("t", 30);
    expect(err).toBeInstanceOf(ToolResultError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ToolTimeoutError");
  });
});

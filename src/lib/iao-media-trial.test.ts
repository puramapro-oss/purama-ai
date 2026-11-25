import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateMediaTrial, inspectMediaFile, type MediaSample } from "./iao-media-trial";

const source: MediaSample = {
  name: "source.mp4", kind: "video", bytes: 300, width: 320, height: 240, durationSeconds: 4,
};
const variant = (fields: Partial<MediaSample> = {}): MediaSample => ({ ...source, bytes: 200, ...fields });

describe("comparaison locale des variantes", () => {
  it("applique les critères inclusifs et départage les égalités par ordre de sélection", () => {
    const variants = [variant(), variant({ bytes: 150 }), variant({ bytes: 150 }), variant({ bytes: 201 })];
    const trial = evaluateMediaTrial(source, variants);
    expect(trial).toMatchObject({ status: "pass", winnerIndex: 1, maxBytes: 200 });
    expect(trial.rows.map((row) => row.status)).toEqual(["pass", "pass", "pass", "fail"]);
    expect(trial.rows[1].reductionPercent).toBe(50);
  });

  it("recalcule sans fichiers à partir des mêmes mesures", () => {
    const before = Object.freeze([variant(), variant({ bytes: 190 })]);
    expect(evaluateMediaTrial(source, before, { minReductionPercent: 10, maxBytes: 180 }).status).toBe("fail");
    expect(evaluateMediaTrial(source, before, { minReductionPercent: 10, maxBytes: 195 }).winnerIndex).toBe(1);
  });

  it("distingue les mesures absentes des échecs prouvés", () => {
    const results = evaluateMediaTrial(source, [
      variant({ durationSeconds: null }), variant({ width: 321 }), variant({ durationSeconds: 4.051 }),
      variant({ kind: "unknown", width: null, bytes: 201 }), variant({ bytes: 0 }),
      variant({ durationSeconds: 4.05 }),
    ]);
    expect(results.rows.map(({ status }) => status)).toEqual(["unverified", "fail", "fail", "fail", "fail", "pass"]);
    expect(evaluateMediaTrial({ ...source, height: null }, [variant()]).status).toBe("unverified");
  });

  it("vérifie les dimensions des images et exige deux médias du même type", () => {
    const image: MediaSample = { ...source, kind: "image", durationSeconds: null };
    expect(evaluateMediaTrial(image, [{ ...image, bytes: 200 }]).status).toBe("pass");
    expect(evaluateMediaTrial(image, [variant()]).status).toBe("fail");
    expect(evaluateMediaTrial(image, [{ ...image, bytes: 150, width: 20 }]).status).toBe("fail");
  });

  it("gère l'absence de fichiers et les plafonds invalides", () => {
    expect(evaluateMediaTrial(null, [variant()]).winnerIndex).toBeNull();
    expect(evaluateMediaTrial(source, []).status).toBe("unverified");
    for (const percent of [NaN, -1, 101]) {
      expect(evaluateMediaTrial(source, [variant()], { minReductionPercent: percent }).status).toBe("unverified");
    }
    expect(evaluateMediaTrial(source, [variant()], { minReductionPercent: 5, maxBytes: Infinity }).status).toBe("unverified");
    expect(evaluateMediaTrial(source, [variant()], { minReductionPercent: 100 }).maxBytes).toBe(0);
  });
});

describe("lecture des médias locaux", () => {
  const asFile = (prefix: string): File => ({
    name: "fichier.mp4", size: 300,
    slice: () => ({ arrayBuffer: async () => Uint8Array.from(prefix, c => c.charCodeAt(0)).buffer }),
  } as unknown as File);
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("refuse de charger une liste de lecture distante déguisée en vidéo", async () => {
    const create = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; });
    const result = await inspectMediaFile(asFile("#EXTM3U\nhttps://"));
    expect(result).toMatchObject({ bytes: 300, kind: "unknown", width: null });
    expect(create).not.toHaveBeenCalled();
  });

  it("lit les métadonnées puis libère l'URL locale", async () => {
    const video = document.createElement("video");
    const create = vi.fn(() => "blob:mesure");
    const revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
    vi.spyOn(document, "createElement").mockReturnValue(video);
    vi.spyOn(video, "load").mockImplementation(() => {});
    Object.defineProperties(video, { videoWidth: { value: 320 }, videoHeight: { value: 240 }, duration: { value: 4 } });
    const pending = inspectMediaFile(asFile("0000ftypisom"));
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(await pending).toMatchObject({ width: 320, height: 240, durationSeconds: 4, kind: "video" });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:mesure");
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("rend un résultat incomplet et nettoie les ressources après annulation", async () => {
    const controller = new AbortController();
    const image = document.createElement("img");
    const revoke = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:annulation"); static revokeObjectURL = revoke;
    });
    vi.spyOn(document, "createElement").mockReturnValue(image);
    const pending = inspectMediaFile(asFile("GIF89a"), controller.signal);
    await vi.waitFor(() => expect(image.hasAttribute("src")).toBe(true));
    controller.abort();
    expect(await pending).toMatchObject({ width: null, height: null });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:annulation");
  });
});

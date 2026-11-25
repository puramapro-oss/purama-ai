export type MediaSample = {
  name: string;
  bytes: number;
  kind?: "image" | "video" | "unknown";
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
};

export type MediaTrialCriteria = { minReductionPercent: number; maxBytes?: number | null };
export type MediaTrialStatus = "pass" | "fail" | "unverified";
export type MediaTrialRow = {
  index: number;
  status: MediaTrialStatus;
  reductionPercent: number | null;
  reasons: string[];
};
export type MediaTrialResult = {
  status: MediaTrialStatus;
  maxBytes: number | null;
  winnerIndex: number | null;
  rows: MediaTrialRow[];
  message: string;
};

export const DEFAULT_MEDIA_CRITERIA: Readonly<MediaTrialCriteria> = { minReductionPercent: 100 / 3 };
export const MEDIA_DURATION_TOLERANCE_SECONDS = 0.05;

// Inspect only recognized local media containers. In particular, never open a playlist
// or an SVG that could refer the browser to external resources.
async function fileKind(file: File): Promise<MediaSample["kind"]> {
  const b = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const tag = (start: number, end: number) => String.fromCharCode(...b.slice(start, end));
  if ((b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    || (b[0] === 0x89 && tag(1, 4) === "PNG")
    || ["GIF87a", "GIF89a"].includes(tag(0, 6))
    || (tag(0, 4) === "RIFF" && tag(8, 12) === "WEBP")) return "image";
  if (tag(4, 8) === "ftyp") {
    if (["avif", "avis", "heic", "heix", "mif1"].includes(tag(8, 12))) return "image";
    return "video";
  }
  if ((b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    || tag(0, 4) === "OggS" || (tag(0, 4) === "RIFF" && tag(8, 12) === "AVI ")) return "video";
  return "unknown";
}

const positive = (value: number | null): value is number => Number.isFinite(value) && value !== null && value > 0;
const validBytes = (bytes: number) => Number.isSafeInteger(bytes) && bytes > 0;

/** The returned snapshot retains neither the File nor its object URL. */
export async function inspectMediaFile(file: File, signal?: AbortSignal): Promise<MediaSample> {
  const sample: MediaSample = {
    name: file.name, bytes: file.size, kind: "unknown", width: null, height: null, durationSeconds: null,
  };
  if (!validBytes(file.size) || signal?.aborted) return sample;
  try {
    sample.kind = await fileKind(file);
    if (signal?.aborted || sample.kind === "unknown") return sample;
    const element = sample.kind === "image" ? document.createElement("img") : document.createElement("video");
    const url = URL.createObjectURL(file);
    return await new Promise<MediaSample>((resolve) => {
      const image = element instanceof HTMLImageElement ? element : null;
      const video = element instanceof HTMLVideoElement ? element : null;
      const event = image ? "load" : "loadedmetadata";
      const finish = () => {
        clearTimeout(timer);
        element.removeEventListener(event, measured);
        element.removeEventListener("error", finish);
        signal?.removeEventListener("abort", finish);
        element.removeAttribute("src");
        if (video) video.load();
        URL.revokeObjectURL(url);
        resolve(sample);
      };
      const measured = () => {
        const width = image?.naturalWidth ?? video?.videoWidth ?? 0;
        const height = image?.naturalHeight ?? video?.videoHeight ?? 0;
        sample.width = positive(width) ? width : null;
        sample.height = positive(height) ? height : null;
        if (video && positive(video.duration)) sample.durationSeconds = video.duration;
        finish();
      };
      const timer = setTimeout(finish, 8000);
      if (video) video.preload = "metadata";
      element.addEventListener(event, measured);
      element.addEventListener("error", finish);
      signal?.addEventListener("abort", finish, { once: true });
      element.src = url;
    });
  } catch {
    return sample;
  }
}

function compareSample(original: MediaSample, candidate: MediaSample, index: number, maxBytes: number): MediaTrialRow {
  const failures: string[] = [];
  const unknown: string[] = [];
  const reductionPercent = validBytes(candidate.bytes) ? (1 - candidate.bytes / original.bytes) * 100 : null;
  if (reductionPercent === null) failures.push("Fichier vide ou taille invalide.");
  else if (candidate.bytes > maxBytes) failures.push("Le fichier dépasse le plafond.");

  const originalKind = original.kind ?? "video";
  const candidateKind = candidate.kind ?? "video";
  if (originalKind === "unknown" || candidateKind === "unknown") unknown.push("Format de média non reconnu.");
  else if (originalKind !== candidateKind) failures.push("Le type de média a changé.");
  if (![original.width, original.height, candidate.width, candidate.height].every(positive)) {
    unknown.push("Dimensions indisponibles.");
  } else if (candidate.width !== original.width || candidate.height !== original.height) {
    failures.push("Les dimensions ont changé.");
  }
  if (originalKind === "video" && candidateKind === "video") {
    if (!positive(original.durationSeconds) || !positive(candidate.durationSeconds)) {
      unknown.push("Durée vidéo indisponible.");
    } else if (Math.abs(original.durationSeconds - candidate.durationSeconds) > MEDIA_DURATION_TOLERANCE_SECONDS + 1e-9) {
      failures.push("La durée diffère de plus de 50 ms.");
    }
  }
  const status = failures.length ? "fail" : unknown.length ? "unverified" : "pass";
  return { index, status, reductionPercent, reasons: [...failures, ...unknown] };
}

export function evaluateMediaTrial(
  original: MediaSample | null,
  candidates: readonly MediaSample[],
  criteria: MediaTrialCriteria = DEFAULT_MEDIA_CRITERIA,
): MediaTrialResult {
  const pending = (message: string): MediaTrialResult => ({
    status: "unverified", winnerIndex: null, maxBytes: null, message,
    rows: candidates.map((_, index) => ({ index, status: "unverified", reductionPercent: null, reasons: [message] })),
  });
  if (!original || !validBytes(original.bytes)) return pending("Choisis un original non vide.");
  const percent = criteria.minReductionPercent;
  if (!Number.isFinite(percent) || percent < 0 || percent > 100
    || (criteria.maxBytes != null && !validBytes(criteria.maxBytes))) {
    return pending("Vérifie les limites de taille.");
  }
  const target = original.bytes * (1 - percent / 100);
  // Do not lose an exact byte boundary to floating-point rounding (e.g. a third of 300).
  const maxBytes = Math.min(criteria.maxBytes ?? original.bytes, Math.floor(target + Math.min(1e-7, Number.EPSILON * original.bytes)));
  const rows = candidates.map((candidate, index) => compareSample(original, candidate, index, maxBytes));
  let winnerIndex: number | null = null;
  for (const row of rows) {
    if (row.status === "pass" && (winnerIndex === null || candidates[row.index].bytes < candidates[winnerIndex].bytes)) {
      winnerIndex = row.index;
    }
  }
  if (winnerIndex !== null) {
    return { status: "pass", maxBytes, winnerIndex, rows, message: "Variante la plus légère parmi celles qui respectent les critères mesurés." };
  }
  const status = !rows.length || rows.some((row) => row.status === "unverified") ? "unverified" : "fail";
  const message = !rows.length ? "Ajoute une variante à comparer."
    : status === "unverified" ? "Les mesures disponibles ne permettent pas de retenir une variante."
    : "Aucune variante ne respecte les critères.";
  return { status, maxBytes, winnerIndex: null, rows, message };
}

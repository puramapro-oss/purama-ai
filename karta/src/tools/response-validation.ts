/** A provider acknowledgement confirms only this response, not delivery or a later business outcome. */
export function requireOutput(condition: unknown, provider: string): asserts condition {
  if (!condition) throw new Error(`${provider}: réponse fournisseur invalide — résultat non confirmé`);
}

export function isOutputObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOutputText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isOutputHttpUrl(value: unknown): value is string {
  if (!isOutputText(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

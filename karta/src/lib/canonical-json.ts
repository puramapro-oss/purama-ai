/** Deterministic JSON with the same normalization as a serialized payload. */
export function canonicalJson(value: unknown): string {
  let normalized: unknown;
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error();
    normalized = JSON.parse(serialized);
  } catch {
    throw new Error("Contenu JSON non sérialisable");
  }
  return encode(normalized);
}

function encode(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${encode(record[key])}`).join(",")}}`;
}

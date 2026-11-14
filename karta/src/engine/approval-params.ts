// Preserve PR21's strict approval comparison contract. Queue fingerprints use
// their own JSON normalization and must not inherit this stricter admission.
const MAX_APPROVAL_CONTEXT_BYTES = 65_536;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const PARAMS_ERROR = "Paramètres de reprise non vérifiables";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(PARAMS_ERROR);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(PARAMS_ERROR);
  return value as Record<string, unknown>;
}

/**
 * Bounded canonical JSON for the approved action's immutable comparison.
 * Never invokes getters/toJSON or silently drops non-JSON data. Key order is
 * immaterial; array order and every supported JSON value remain significant.
 */
export function canonicalApprovalParams(value: unknown): string {
  record(value);
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const part = (text: string): string => {
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > MAX_APPROVAL_CONTEXT_BYTES) throw new Error(PARAMS_ERROR);
    return text;
  };
  const quote = (text: string): string => {
    if (text.length > MAX_APPROVAL_CONTEXT_BYTES) throw new Error(PARAMS_ERROR);
    return part(JSON.stringify(text));
  };
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error(PARAMS_ERROR);
    if (item === null) return part("null");
    if (typeof item === "string") return quote(item);
    if (typeof item === "boolean") return part(String(item));
    if (typeof item === "number" && Number.isFinite(item)) return part(JSON.stringify(item));
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error(PARAMS_ERROR);
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || item.length > MAX_JSON_NODES - nodes ||
            Reflect.ownKeys(item).length !== item.length + 1) throw new Error(PARAMS_ERROR);
        const entries: string[] = [];
        for (let i = 0; i < item.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(item, String(i));
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(PARAMS_ERROR);
          entries.push(visit(descriptor.value, depth + 1));
        }
        part(",".repeat(Math.max(0, entries.length - 1)));
        return part("[") + entries.join(",") + part("]");
      }
      const object = record(item);
      const keys = Reflect.ownKeys(object);
      // Every property needs at least one value node. Check before sorting an
      // oversized object or allocating its encoded entries.
      if (keys.length > MAX_JSON_NODES - nodes) throw new Error(PARAMS_ERROR);
      let minimumKeyBytes = 0;
      for (const key of keys) {
        if (typeof key !== "string") throw new Error(PARAMS_ERROR);
        // A lower bound only: UTF-8 and JSON escaping are charged exactly by
        // quote below. Bound key comparisons before the lexical sort as well.
        minimumKeyBytes += key.length + 3;
        if (minimumKeyBytes > MAX_APPROVAL_CONTEXT_BYTES - bytes) throw new Error(PARAMS_ERROR);
      }
      const entries: string[] = [];
      for (const key of (keys as string[]).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error(PARAMS_ERROR);
        entries.push(quote(key) + part(":") + visit(descriptor.value, depth + 1));
      }
      part(",".repeat(Math.max(0, entries.length - 1)));
      return part("{") + entries.join(",") + part("}");
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

/** A resolved Promise is not sufficient evidence of a successful business action. */
export function assertToolResult(result: unknown): void {
  if (result === false) {
    throw new Error("L’outil a déclaré un échec");
  }

  if (result === null || result === undefined || typeof result !== "object" || Array.isArray(result)) {
    return;
  }

  const value = result as Record<string, unknown>;

  if ("ok" in value && value.ok !== true) {
    throw new Error("L’outil a déclaré un échec");
  }
  if ("success" in value && value.success !== true) {
    throw new Error("L’outil a déclaré un échec");
  }
  if ("error" in value && value.error !== undefined && value.error !== null && value.error !== false && value.error !== "") {
    throw new Error("L’outil a déclaré un échec");
  }
}

/** A resolved Promise is not sufficient evidence of a successful business action. */
export function assertToolResult(result: unknown): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) return;
  const value = result as Record<string, unknown>;
  if (value.ok === false || value.success === false || (value.error !== undefined && value.error !== null && value.error !== false)) {
    throw new Error("L'outil a déclaré un échec");
  }
}

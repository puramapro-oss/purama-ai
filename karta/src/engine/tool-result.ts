/** A resolved Promise is not sufficient evidence of a successful business action. */
export function assertToolResult(result: unknown): void {
  if (result === false) throw new Error("L'outil a déclaré un échec");
  if (!result || typeof result !== "object" || Array.isArray(result)) return;

  const value = result as Record<string, unknown>;
  const owns = (key: string) => Object.prototype.hasOwnProperty.call(value, key);

  if (owns("ok") && value.ok !== true) throw new Error("L'outil a déclaré un échec");
  if (owns("success") && value.success !== true) throw new Error("L'outil a déclaré un échec");

  if (owns("error")) {
    const error = value.error;
    if (error !== undefined && error !== null && error !== false && error !== "") {
      throw new Error("L'outil a déclaré un échec");
    }
  }

  if (owns("status") && typeof value.status === "string") {
    const status = value.status.toLowerCase();
    if (["error", "failed", "failure", "denied", "rejected", "cancelled", "canceled"].includes(status)) {
      throw new Error("L'outil a déclaré un échec");
    }
  }
}

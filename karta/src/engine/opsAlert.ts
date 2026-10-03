import { config } from "../config.js";

export type OpsAlertSource = "worker" | "scheduler" | "approval-reconciler";

/** Alerte best-effort sans secret; elle ne relance jamais une operation metier. */
export async function alertOps(source: OpsAlertSource, message: string): Promise<void> {
  if (!config.opsAlertUrl) return;
  const url = validateOpsUrl(config.opsAlertUrl);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, message: sanitizeOpsMessage(message), occurred_at: new Date().toISOString() }),
    signal: AbortSignal.timeout(config.opsAlertTimeoutMs),
  });
  if (!response.ok) throw new Error(`alerte ops refusee (${response.status})`);
}

export function reportOpsFailure(source: OpsAlertSource, message: string): void {
  void alertOps(source, message).catch((error) => {
    console.error(`[ops-alert] ${source}:`, error instanceof Error ? error.message : String(error));
  });
}

function validateOpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("KARTA_OPS_ALERT_URL doit utiliser HTTPS");
  url.username = "";
  url.password = "";
  return url.toString();
}

export function sanitizeOpsMessage(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|gsk|rk|whsec)_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 500);
}

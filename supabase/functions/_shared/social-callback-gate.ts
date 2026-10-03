const MIN_SECRET_LENGTH = 32;

export type SocialCallbackGate =
  | { enabled: true; secret: string }
  | { enabled: false; reason: "disabled" | "invalid_secret" };

export function getSocialCallbackGate(
  enabledValue: string | undefined,
  secretValue: string | undefined,
): SocialCallbackGate {
  if (enabledValue !== "true") return { enabled: false, reason: "disabled" };

  const secret = secretValue ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    return { enabled: false, reason: "invalid_secret" };
  }

  return { enabled: true, secret };
}

export async function verifySocialCallbackSecret(
  provided: string | null,
  expected: string,
): Promise<boolean> {
  if (!provided || expected.length < MIN_SECRET_LENGTH) return false;

  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(providedHash);
  const right = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

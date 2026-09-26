// R1 Red Team : `social-callback` faisait confiance a un `user_id` brut recu en
// query string sans aucune verification — n'importe qui pouvait appeler l'URL du
// callback directement avec le user_id d'une victime et lier un compte social
// attaquant a sa place (hijack de liaison de compte, classe "callback trust").
// Ce module signe/verifie un jeton d'etat opaque et expirant a la place.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

export async function createSocialCallbackState(
  userId: string,
  secret: string,
  ttlMs = 10 * 60 * 1000,
): Promise<string> {
  const expiresAt = Date.now() + ttlMs;
  const payload = `${userId}.${expiresAt}`;
  const sig = await hmacHex(secret, payload);
  return encodeURIComponent(`${payload}.${sig}`);
}

export async function verifySocialCallbackState(
  state: string | null,
  secret: string,
): Promise<string | null> {
  if (!state || !secret) return null;
  const parts = decodeURIComponent(state).split(".");
  if (parts.length !== 3) return null;
  const [userId, expiresAtStr, sig] = parts;
  const expiresAt = Number(expiresAtStr);
  if (!userId || !Number.isFinite(expiresAt)) return null;
  if (Date.now() > expiresAt) return null;
  const expectedSig = await hmacHex(secret, `${userId}.${expiresAtStr}`);
  if (!timingSafeEqualHex(expectedSig, sig)) return null;
  return userId;
}

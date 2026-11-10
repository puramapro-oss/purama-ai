// Shared signed-token contract cases. All keys and identities are synthetic.
export const NOW = 1_800_000_000;
export const CURRENT_SECRET = 'cross-app-jwt-fixture-current-key';
export const PREVIOUS_SECRET = 'cross-app-jwt-fixture-previous-key';
export const BASE = {
  iss: 'fixture-app', aud: 'purama-contracts-hub', app_slug: 'fixture-app',
  iat: NOW, exp: NOW + 300, jti: 'fixture-request',
};

/** @typedef {{ name: string, accepted: boolean, payload?: unknown, header?: unknown,
 * rawPayload?: string, rawHeader?: string, signingSecret?: string, secrets?: string[],
 * transform?: (token: string) => string }} JwtCase */
/** @type {JwtCase[]} */
export const cases = [
  { name: 'valid locally signed token', accepted: true },
  { name: 'missing expiration', payload: { ...BASE, exp: undefined }, accepted: false },
  { name: 'nonnumeric expiration', payload: { ...BASE, exp: 'not-a-number' }, accepted: false },
  { name: 'future issue time beyond tolerance', payload: { ...BASE, iat: NOW + 31 }, accepted: false },
  { name: 'unsupported header algorithm despite HMAC bytes', header: { alg: 'none', typ: 'JWT' }, accepted: false },
  { name: 'missing application claim', payload: { ...BASE, app_slug: undefined }, accepted: false },
  { name: 'wrong audience control', payload: { ...BASE, aud: 'other-service' }, accepted: false },
  { name: 'expired token control', payload: { ...BASE, exp: NOW - 120 }, accepted: false },
  { name: 'previous signing key remains valid during rotation', signingSecret: PREVIOUS_SECRET,
    secrets: [CURRENT_SECRET, PREVIOUS_SECRET], accepted: true },
  { name: 'current signing key remains valid during rotation',
    secrets: [CURRENT_SECRET, PREVIOUS_SECRET], accepted: true },
  { name: 'expiration at the existing 30 second tolerance boundary', payload: { ...BASE, exp: NOW - 30 }, accepted: true },
  { name: 'expiration beyond the 30 second tolerance boundary', payload: { ...BASE, exp: NOW - 31 }, accepted: false },
  { name: 'issue time at the existing 30 second tolerance boundary', payload: { ...BASE, iat: NOW + 30 }, accepted: true },
  { name: 'fractional NumericDate values remain valid', payload: { ...BASE, iat: NOW + 0.25, exp: NOW + 300.75 }, accepted: true },
  { name: 'issuer need not equal application slug', payload: { ...BASE, iss: 'another-fixture-issuer' }, accepted: true },
  { name: 'contract does not impose a new maximum lifetime', payload: { ...BASE, exp: NOW + 86_400 }, accepted: true },
  { name: 'optional token identifier can be absent', payload: { ...BASE, jti: undefined }, accepted: true },
  { name: 'JWT typ header remains optional', header: { alg: 'HS256' }, accepted: true },
  { name: 'numeric string expiration is not NumericDate', payload: { ...BASE, exp: String(NOW + 300) }, accepted: false },
  { name: 'null expiration is not NumericDate', payload: { ...BASE, exp: null }, accepted: false },
  { name: 'positive infinite expiration from JSON exponent', rawPayload: JSON.stringify(BASE).replace(String(BASE.exp), '1e999'), accepted: false },
  { name: 'negative infinite expiration from JSON exponent', rawPayload: JSON.stringify(BASE).replace(String(BASE.exp), '-1e999'), accepted: false },
  { name: 'missing issue time', payload: { ...BASE, iat: undefined }, accepted: false },
  { name: 'nonnumeric issue time', payload: { ...BASE, iat: 'not-a-number' }, accepted: false },
  { name: 'null issue time', payload: { ...BASE, iat: null }, accepted: false },
  { name: 'positive infinite issue time from JSON exponent', rawPayload: JSON.stringify(BASE).replace(String(BASE.iat), '1e999'), accepted: false },
  { name: 'negative infinite issue time from JSON exponent', rawPayload: JSON.stringify(BASE).replace(String(BASE.iat), '-1e999'), accepted: false },
  { name: 'empty application claim', payload: { ...BASE, app_slug: '' }, accepted: false },
  { name: 'blank application claim', payload: { ...BASE, app_slug: ' \t ' }, accepted: false },
  { name: 'application claim must be a string', payload: { ...BASE, app_slug: 123 }, accepted: false },
  { name: 'missing issuer', payload: { ...BASE, iss: undefined }, accepted: false },
  { name: 'empty issuer', payload: { ...BASE, iss: '' }, accepted: false },
  { name: 'blank issuer', payload: { ...BASE, iss: ' \t ' }, accepted: false },
  { name: 'issuer must be a string', payload: { ...BASE, iss: 123 }, accepted: false },
  { name: 'missing header algorithm', header: { typ: 'JWT' }, accepted: false },
  { name: 'header algorithm must be HS256 string', header: { alg: 256 }, accepted: false },
  { name: 'other HMAC algorithm label is not accepted', header: { alg: 'HS384' }, accepted: false },
  { name: 'null JWT header', header: null, accepted: false },
  { name: 'array JWT header', header: [], accepted: false },
  { name: 'null JWT payload', payload: null, accepted: false },
  { name: 'array JWT payload', payload: [], accepted: false },
  { name: 'optional token identifier must be a string when supplied', payload: { ...BASE, jti: 123 }, accepted: false },
  { name: 'signature from an untrusted key is rejected', signingSecret: 'untrusted-fixture-key', accepted: false },
  { name: 'payload modification invalidates the signature',
    transform: token => { const parts = token.split('.'); parts[1] = encode(JSON.stringify({ ...BASE, app_slug: 'tampered-fixture' })); return parts.join('.'); },
    accepted: false },
  { name: 'empty allowed key list rejects signed tokens', secrets: [], accepted: false },
  { name: 'JWT must have three segments', transform: token => token.split('.').slice(0, 2).join('.'), accepted: false },
  { name: 'signed malformed payload JSON is rejected', rawPayload: '{', accepted: false },
  { name: 'signed malformed header JSON is rejected', rawHeader: '{', accepted: false },
];

export function encode(text) {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Build fixtures independently of the application's signer and verifier. */
export async function signedFixture(item) {
  const header = item.rawHeader ?? JSON.stringify(Object.hasOwn(item, 'header') ? item.header : { alg: 'HS256', typ: 'JWT' });
  const payload = item.rawPayload ?? JSON.stringify(Object.hasOwn(item, 'payload') ? item.payload : BASE);
  const input = `${encode(header)}.${encode(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(item.signingSecret ?? CURRENT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input)));
  const encodedSignature = btoa(String.fromCharCode(...signature)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = `${input}.${encodedSignature}`;
  return item.transform ? item.transform(token) : token;
}

/** Only verifier rejection is an expected negative result; fixture failures propagate. */
export async function evaluateCase(verify, item) {
  const token = await signedFixture(item);
  const previousNow = Date.now;
  Date.now = () => NOW * 1000;
  try {
    try {
      const payload = await verify(token, item.secrets ?? [CURRENT_SECRET]);
      return { accepted: true, payload };
    } catch (cause) {
      return { accepted: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  } finally {
    Date.now = previousNow;
  }
}

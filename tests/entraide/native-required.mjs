// A native CI gate must never silently fall back to single-connection WASM.
if (!process.env.ENTRAIDE_DATABASE_URL) {
  throw new Error('Native PostgreSQL gate requires ENTRAIDE_DATABASE_URL; use test:sql for PGlite.');
}

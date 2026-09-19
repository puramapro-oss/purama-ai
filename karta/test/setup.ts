// Tests must never inherit real credentials. Provider operations use explicit doubles.
process.env.SUPABASE_URL = "https://example.invalid";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-not-a-secret";
process.env.ANTHROPIC_API_KEY = "test-only-not-a-secret";
process.env.STRIPE_SECRET_KEY = "test-only-not-a-secret";
process.env.KARTA_MOCK_CLAUDE = "true";
process.env.KARTA_ADMIN_TOKEN = "test-only-admin";
process.env.KARTA_PORT = "0";
globalThis.fetch = async () => { throw new Error("Unexpected network call in unit test"); };

// Valeurs volontairement factices : la suite KARTA ne doit jamais dépendre des
// secrets de la machine/CI ni contacter un Supabase réel.
Object.assign(process.env, {
  NODE_ENV: "test",
  KARTA_MOCK_CLAUDE: "true",
  SUPABASE_URL: "https://supabase.test.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-secret",
  ANTHROPIC_API_KEY: "",
  STRIPE_SECRET_KEY: "",
  RESEND_API_KEY: "",
  TAVILY_API_KEY: "",
  ZERNIO_API_KEY: "",
  DOCUSEAL_API_KEY: "",
  APOLLO_API_KEY: "",
});

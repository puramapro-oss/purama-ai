-- Short-lived, one-time server-side binding for Gmail OAuth state and PKCE.
CREATE TABLE IF NOT EXISTS purama_ai.email_agent_oauth_states (
  nonce_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE purama_ai.email_agent_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE purama_ai.email_agent_oauth_states FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_email_agent_oauth_states_expiry
  ON purama_ai.email_agent_oauth_states(expires_at);

COMMENT ON TABLE purama_ai.email_agent_oauth_states IS
  'Service-role-only, one-time Gmail OAuth state bindings; expired rows may be purged.';

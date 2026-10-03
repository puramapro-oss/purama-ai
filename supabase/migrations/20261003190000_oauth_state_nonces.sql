CREATE TABLE IF NOT EXISTS purama_ai.oauth_state_nonces (
  nonce uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE purama_ai.oauth_state_nonces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.oauth_state_nonces FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS oauth_state_nonces_expiry_idx ON purama_ai.oauth_state_nonces (expires_at);

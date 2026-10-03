-- Public contact form: private storage with a single validated, rate-limited write RPC.
-- No anonymous/authenticated role can read or write the table directly.

CREATE TABLE IF NOT EXISTS purama_ai.contact_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_submissions_name_bounds CHECK (char_length(name) BETWEEN 2 AND 100),
  CONSTRAINT contact_submissions_email_bounds CHECK (
    char_length(email) BETWEEN 3 AND 254
    AND email ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  ),
  CONSTRAINT contact_submissions_company_bounds CHECK (company IS NULL OR char_length(company) BETWEEN 1 AND 100),
  CONSTRAINT contact_submissions_message_bounds CHECK (char_length(message) BETWEEN 10 AND 2000),
  CONSTRAINT contact_submissions_status_allowed CHECK (status IN ('new', 'in_progress', 'resolved', 'spam')),
  CONSTRAINT contact_submissions_fingerprint_shape CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_contact_submissions_created_at
  ON purama_ai.contact_submissions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_email_created_at
  ON purama_ai.contact_submissions(lower(email), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_submissions_fingerprint_created_at
  ON purama_ai.contact_submissions(request_fingerprint, created_at DESC);

ALTER TABLE purama_ai.contact_submissions ENABLE ROW LEVEL SECURITY;

-- Intentionally no RLS policy: even INSERT goes through submit_contact so validation and
-- throttling cannot be bypassed. service_role remains the only administrative table role.
REVOKE ALL ON TABLE purama_ai.contact_submissions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE purama_ai.contact_submissions TO service_role;

CREATE OR REPLACE FUNCTION purama_ai.submit_contact(
  p_name TEXT,
  p_email TEXT,
  p_company TEXT,
  p_message TEXT,
  p_website TEXT,
  p_started_at TIMESTAMPTZ
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, purama_ai, extensions, pg_temp
AS $$
DECLARE
  v_name TEXT := btrim(p_name);
  v_email TEXT := lower(btrim(p_email));
  v_company TEXT := nullif(btrim(p_company), '');
  v_message TEXT := btrim(p_message);
  v_headers JSONB := '{}'::jsonb;
  v_client_ip TEXT := 'unknown';
  v_fingerprint TEXT;
  v_id UUID;
BEGIN
  -- Honeypot and minimum interaction time stop basic automated floods. They supplement,
  -- but never replace, the server-side quotas below.
  IF coalesce(p_website, '') <> ''
    OR p_started_at IS NULL
    OR p_started_at > clock_timestamp()
    OR clock_timestamp() - p_started_at < interval '2 seconds'
    OR clock_timestamp() - p_started_at > interval '24 hours'
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'contact_invalid';
  END IF;

  IF char_length(v_name) NOT BETWEEN 2 AND 100
    OR char_length(v_email) NOT BETWEEN 3 AND 254
    OR v_email !~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    OR (v_company IS NOT NULL AND char_length(v_company) NOT BETWEEN 1 AND 100)
    OR char_length(v_message) NOT BETWEEN 10 AND 2000
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'contact_invalid';
  END IF;

  BEGIN
    v_headers := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  EXCEPTION WHEN others THEN
    v_headers := '{}'::jsonb;
  END;
  v_client_ip := split_part(coalesce(v_headers ->> 'x-forwarded-for', v_headers ->> 'x-real-ip', 'unknown'), ',', 1);
  v_fingerprint := encode(extensions.digest(v_client_ip || '|' || current_date::text || '|purama-contact', 'sha256'), 'hex');

  -- Serialize submissions for one normalized email to close concurrent quota races.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_email, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_fingerprint, 1));
  IF (SELECT count(*) FROM purama_ai.contact_submissions
      WHERE lower(email) = v_email AND created_at >= clock_timestamp() - interval '1 hour') >= 3
    OR (SELECT count(*) FROM purama_ai.contact_submissions
        WHERE request_fingerprint = v_fingerprint AND created_at >= clock_timestamp() - interval '1 hour') >= 10
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'contact_rate_limit';
  END IF;

  INSERT INTO purama_ai.contact_submissions (name, email, company, message, request_fingerprint)
  VALUES (v_name, v_email, v_company, v_message, v_fingerprint)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.submit_contact(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purama_ai.submit_contact(TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ)
  TO anon, authenticated;

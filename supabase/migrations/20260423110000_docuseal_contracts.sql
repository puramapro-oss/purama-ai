-- DocuSeal Contracts Hub — central contract management for Purama ecosystem
-- Phase 2 of DocuSeal integration
-- Tables live in purama_ai schema (this app = hub). Other apps access via Edge Functions.

-- Cleanup: drop any accidental public schema tables from previous migration attempts
DROP TABLE IF EXISTS public.contract_events CASCADE;
DROP TABLE IF EXISTS public.contract_signers CASCADE;
DROP TABLE IF EXISTS public.contract_templates CASCADE;
DROP TABLE IF EXISTS public.contracts CASCADE;
DROP TYPE IF EXISTS public.contract_status CASCADE;
DROP TYPE IF EXISTS public.contract_signer_role CASCADE;
DROP TYPE IF EXISTS public.contract_event_type CASCADE;
DROP FUNCTION IF EXISTS public.set_updated_at_contracts() CASCADE;
DROP FUNCTION IF EXISTS public.anonymize_contract_user(UUID) CASCADE;

-- =============================================================================
-- Enums (in purama_ai schema)
-- =============================================================================

DO $$ BEGIN
    CREATE TYPE purama_ai.contract_status AS ENUM (
        'draft', 'sent', 'opened', 'signed', 'declined', 'cancelled', 'expired'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE purama_ai.contract_signer_role AS ENUM (
        'ambassadeur', 'purama_rep', 'business_partner', 'witness'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE purama_ai.contract_event_type AS ENUM (
        'created', 'sent', 'opened', 'signed', 'declined', 'reminded', 'cancelled', 'expired',
        'ots_stamped', 'ots_verified', 'anonymized'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =============================================================================
-- contracts
-- =============================================================================

CREATE TABLE IF NOT EXISTS purama_ai.contracts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    app_slug TEXT NOT NULL,
    template_slug TEXT NOT NULL,
    status purama_ai.contract_status NOT NULL DEFAULT 'draft',

    docuseal_submission_id BIGINT UNIQUE,
    docuseal_template_id BIGINT,

    pdf_url TEXT,
    pdf_storage_path TEXT,
    pdf_original_url TEXT,

    ots_stamp_hash TEXT,
    ots_proof TEXT,
    ots_verified_at TIMESTAMPTZ,
    ots_block_height BIGINT,
    ots_btc_timestamp TIMESTAMPTZ,

    commission_rate NUMERIC(5,2),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    signed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contracts_user_id ON purama_ai.contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_contracts_app_slug ON purama_ai.contracts(app_slug);
CREATE INDEX IF NOT EXISTS idx_contracts_template_slug ON purama_ai.contracts(template_slug);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON purama_ai.contracts(status);
CREATE INDEX IF NOT EXISTS idx_contracts_docuseal_id ON purama_ai.contracts(docuseal_submission_id);
CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON purama_ai.contracts(created_at DESC);

-- =============================================================================
-- contract_signers
-- =============================================================================

CREATE TABLE IF NOT EXISTS purama_ai.contract_signers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES purama_ai.contracts(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    role purama_ai.contract_signer_role NOT NULL,
    order_index INT NOT NULL DEFAULT 0,

    signed BOOLEAN NOT NULL DEFAULT false,
    signed_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    declined_at TIMESTAMPTZ,

    ip_address INET,
    user_agent TEXT,
    signature_image_url TEXT,

    docuseal_submitter_id BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_signers_contract_id ON purama_ai.contract_signers(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_signers_email ON purama_ai.contract_signers(email);
CREATE INDEX IF NOT EXISTS idx_contract_signers_docuseal ON purama_ai.contract_signers(docuseal_submitter_id);

-- =============================================================================
-- contract_events
-- =============================================================================

CREATE TABLE IF NOT EXISTS purama_ai.contract_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id UUID NOT NULL REFERENCES purama_ai.contracts(id) ON DELETE CASCADE,
    event_type purama_ai.contract_event_type NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_type TEXT,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_events_contract_id ON purama_ai.contract_events(contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_events_type ON purama_ai.contract_events(event_type);
CREATE INDEX IF NOT EXISTS idx_contract_events_created_at ON purama_ai.contract_events(created_at DESC);

-- =============================================================================
-- contract_templates
-- =============================================================================

CREATE TABLE IF NOT EXISTS purama_ai.contract_templates (
    slug TEXT PRIMARY KEY,
    version INT NOT NULL DEFAULT 1,
    name TEXT NOT NULL,
    description TEXT,
    html_template TEXT NOT NULL,
    variables JSONB NOT NULL DEFAULT '[]'::jsonb,
    tier_required TEXT,
    docuseal_template_id BIGINT,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================================================
-- updated_at triggers
-- =============================================================================

CREATE OR REPLACE FUNCTION purama_ai.set_updated_at_contracts() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contracts_updated_at ON purama_ai.contracts;
CREATE TRIGGER contracts_updated_at BEFORE UPDATE ON purama_ai.contracts
    FOR EACH ROW EXECUTE FUNCTION purama_ai.set_updated_at_contracts();

DROP TRIGGER IF EXISTS contract_signers_updated_at ON purama_ai.contract_signers;
CREATE TRIGGER contract_signers_updated_at BEFORE UPDATE ON purama_ai.contract_signers
    FOR EACH ROW EXECUTE FUNCTION purama_ai.set_updated_at_contracts();

DROP TRIGGER IF EXISTS contract_templates_updated_at ON purama_ai.contract_templates;
CREATE TRIGGER contract_templates_updated_at BEFORE UPDATE ON purama_ai.contract_templates
    FOR EACH ROW EXECUTE FUNCTION purama_ai.set_updated_at_contracts();

-- =============================================================================
-- RGPD anonymization
-- =============================================================================

CREATE OR REPLACE FUNCTION purama_ai.anonymize_contract_user(_user_id UUID)
RETURNS INT AS $$
DECLARE
    v_count INT := 0;
    v_hash TEXT;
BEGIN
    v_hash := encode(extensions.digest(_user_id::text || 'purama-anonymize-salt', 'sha256'), 'hex');
    UPDATE purama_ai.contracts
       SET metadata = metadata || jsonb_build_object(
             'anonymized', true,
             'anonymized_at', now(),
             'user_hash', substr(v_hash, 1, 16)
           ) - 'email' - 'full_name' - 'address' - 'phone' - 'iban' - 'siret'
     WHERE user_id = _user_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    UPDATE purama_ai.contract_signers cs
       SET email = substr(v_hash, 1, 16) || '@anonymized.purama.local',
           name = 'Anonymized User',
           ip_address = NULL,
           user_agent = NULL
      FROM purama_ai.contracts c
     WHERE cs.contract_id = c.id AND c.user_id = _user_id;
    INSERT INTO purama_ai.contract_events (contract_id, event_type, payload, actor_id, actor_type)
    SELECT id, 'anonymized', jsonb_build_object('reason', 'RGPD request'), _user_id, 'user'
      FROM purama_ai.contracts WHERE user_id = _user_id;
    RETURN v_count;
END $$ LANGUAGE plpgsql SECURITY DEFINER;

-- =============================================================================
-- RLS policies (using purama_ai.has_role + purama_ai.app_role)
-- =============================================================================

ALTER TABLE purama_ai.contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.contract_signers ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.contract_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.contract_templates ENABLE ROW LEVEL SECURITY;

-- contracts
DROP POLICY IF EXISTS "Users view own contracts" ON purama_ai.contracts;
CREATE POLICY "Users view own contracts" ON purama_ai.contracts
    FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins manage contracts" ON purama_ai.contracts;
CREATE POLICY "Admins manage contracts" ON purama_ai.contracts
    FOR ALL USING (purama_ai.has_role(auth.uid(), 'admin'::purama_ai.app_role));

-- contract_signers
DROP POLICY IF EXISTS "Users view own contract signers" ON purama_ai.contract_signers;
CREATE POLICY "Users view own contract signers" ON purama_ai.contract_signers
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM purama_ai.contracts c
                 WHERE c.id = contract_id AND c.user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Admins manage signers" ON purama_ai.contract_signers;
CREATE POLICY "Admins manage signers" ON purama_ai.contract_signers
    FOR ALL USING (purama_ai.has_role(auth.uid(), 'admin'::purama_ai.app_role));

-- contract_events
DROP POLICY IF EXISTS "Users view own contract events" ON purama_ai.contract_events;
CREATE POLICY "Users view own contract events" ON purama_ai.contract_events
    FOR SELECT USING (
        EXISTS (SELECT 1 FROM purama_ai.contracts c
                 WHERE c.id = contract_id AND c.user_id = auth.uid())
    );

DROP POLICY IF EXISTS "Admins view all events" ON purama_ai.contract_events;
CREATE POLICY "Admins view all events" ON purama_ai.contract_events
    FOR SELECT USING (purama_ai.has_role(auth.uid(), 'admin'::purama_ai.app_role));

-- contract_templates
DROP POLICY IF EXISTS "Anyone view active templates" ON purama_ai.contract_templates;
CREATE POLICY "Anyone view active templates" ON purama_ai.contract_templates
    FOR SELECT USING (active = true);

DROP POLICY IF EXISTS "Admins manage templates" ON purama_ai.contract_templates;
CREATE POLICY "Admins manage templates" ON purama_ai.contract_templates
    FOR ALL USING (purama_ai.has_role(auth.uid(), 'admin'::purama_ai.app_role));

-- Expose schema via PostgREST (API access)
GRANT USAGE ON SCHEMA purama_ai TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.contracts TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON purama_ai.contract_signers TO authenticated, service_role;
GRANT SELECT, INSERT ON purama_ai.contract_events TO authenticated, service_role;
GRANT SELECT ON purama_ai.contract_templates TO authenticated, anon, service_role;
GRANT ALL ON purama_ai.contract_templates TO service_role;

COMMENT ON TABLE purama_ai.contracts IS 'DocuSeal contracts hub — central table for Purama ecosystem (10 apps)';
COMMENT ON TABLE purama_ai.contract_signers IS 'Multi-signer support (ambassadeur + Purama rep)';
COMMENT ON TABLE purama_ai.contract_events IS 'Complete audit trail including OTS blockchain stamping';
COMMENT ON TABLE purama_ai.contract_templates IS 'Versioned HTML templates synced with DocuSeal';
COMMENT ON FUNCTION purama_ai.anonymize_contract_user(UUID) IS 'RGPD erasure preserving 10y compta obligation structure';

-- Durable identity for one requested publication and server-owned evidence.
-- Existing rows are preserved. Their NULL request keys and account snapshots
-- must not be fabricated: old scheduled rows require review before publishing.
-- Main creates these tables in public; some deployments use purama_ai. Apply
-- only to tables that actually exist and never move or duplicate their data.

BEGIN;

DO $migration$
DECLARE
  schema_name text;
  table_name text;
  column_list text;
BEGIN
  FOREACH schema_name IN ARRAY ARRAY['public', 'purama_ai'] LOOP
    IF to_regclass(format('%I.social_posts', schema_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.social_posts ADD COLUMN IF NOT EXISTS client_request_id text', schema_name);
      EXECUTE format('ALTER TABLE %I.social_posts ADD COLUMN IF NOT EXISTS request_hash text', schema_name);
      EXECUTE format('ALTER TABLE %I.social_posts ADD COLUMN IF NOT EXISTS target_accounts jsonb', schema_name);
      EXECUTE format('ALTER TABLE %I.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check', schema_name);
      EXECUTE format($ddl$
        ALTER TABLE %I.social_posts ADD CONSTRAINT social_posts_status_check
        CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'publish_unconfirmed'))
      $ddl$, schema_name);
      EXECUTE format('ALTER TABLE %I.social_posts DROP CONSTRAINT IF EXISTS social_posts_request_identity_check', schema_name);
      EXECUTE format($ddl$
        ALTER TABLE %I.social_posts ADD CONSTRAINT social_posts_request_identity_check
        CHECK (
          (client_request_id IS NULL AND request_hash IS NULL)
          OR (
            client_request_id IS NOT NULL AND request_hash IS NOT NULL
            AND client_request_id ~ '^[A-Za-z0-9_-]{16,128}$'
            AND request_hash ~ '^[0-9a-f]{64}$'
          )
        )
      $ddl$, schema_name);
      EXECUTE format($ddl$
        CREATE UNIQUE INDEX IF NOT EXISTS social_posts_user_client_request_uidx
        ON %I.social_posts (user_id, client_request_id)
        WHERE client_request_id IS NOT NULL
      $ddl$, schema_name);
    END IF;

    IF to_regclass(format('%I.social_accounts', schema_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I.social_accounts ADD COLUMN IF NOT EXISTS publishing_verified_at timestamptz', schema_name);
      -- Intentionally no backfill: a legacy callback parameter is not proof
      -- that this user controls the external account.
    END IF;

    FOREACH table_name IN ARRAY ARRAY['social_posts', 'social_accounts'] LOOP
      IF to_regclass(format('%I.%I', schema_name, table_name)) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, anon, authenticated', schema_name, table_name);
        -- Revoke possible older column grants as well as table grants. RLS
        -- ownership alone must not let clients forge statuses/provider IDs.
        SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
          INTO column_list
          FROM pg_attribute
          WHERE attrelid = to_regclass(format('%I.%I', schema_name, table_name))
            AND attnum > 0 AND NOT attisdropped;
        EXECUTE format(
          'REVOKE SELECT (%s), INSERT (%s), UPDATE (%s), REFERENCES (%s) ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
          column_list, column_list, column_list, column_list, schema_name, table_name
        );
        EXECUTE format('GRANT SELECT ON TABLE %I.%I TO authenticated', schema_name, table_name);
        EXECUTE format('GRANT ALL PRIVILEGES ON TABLE %I.%I TO service_role', schema_name, table_name);
      END IF;
    END LOOP;
  END LOOP;
END
$migration$;

COMMIT;

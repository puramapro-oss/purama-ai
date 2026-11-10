-- Server-owned Zernio profiles and one-use OAuth intents. Apply after 003.
-- Does not move schemas, adopt historical accounts or call an external provider.
BEGIN;
DO $migration$
DECLARE
  s text;
  relation_name text;
  column_names text;
  found_schema boolean := false;
BEGIN
  FOREACH s IN ARRAY ARRAY['public', 'purama_ai'] LOOP
    IF to_regclass(format('%I.social_accounts', s)) IS NULL THEN CONTINUE; END IF;
    found_schema := true;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = s AND table_name = 'social_accounts' AND column_name = 'publishing_verified_at') THEN
      RAISE EXCEPTION 'Apply social publication migration 003 before binding migration in schema %', s;
    END IF;

    EXECUTE format($ddl$
      ALTER TABLE %1$I.social_accounts
        ADD COLUMN IF NOT EXISTS disconnect_pending boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS disconnect_reconcile_ready boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS disconnect_completed_at timestamptz;
      CREATE TABLE IF NOT EXISTS %1$I.social_profile_bindings (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
        zernio_profile_id text UNIQUE CHECK (zernio_profile_id ~ '^[0-9a-f]{24}$'),
        external_id text NOT NULL UNIQUE,
        profile_name text NOT NULL UNIQUE,
        creation_status text NOT NULL DEFAULT 'pending' CHECK (creation_status IN ('pending','creating','uncertain','ready')),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        CHECK ((creation_status = 'ready') = (zernio_profile_id IS NOT NULL))
      );
      CREATE TABLE IF NOT EXISTS %1$I.social_connection_intents (
        state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
        nonce uuid NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        platform text NOT NULL CHECK (platform IN ('youtube','tiktok','instagram','facebook','threads','linkedin',
          'twitter','pinterest','reddit','snapchat','google_business','whatsapp')),
        zernio_profile_id text NOT NULL CHECK (zernio_profile_id ~ '^[0-9a-f]{24}$'),
        issued_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','bound','cancelled','superseded')),
        zernio_account_id text CHECK (zernio_account_id ~ '^[0-9a-f]{24}$'),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        consumed_at timestamptz,
        CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '10 minutes'),
        CHECK ((status = 'bound') = (zernio_account_id IS NOT NULL)),
        CHECK ((status = 'pending') = (consumed_at IS NULL))
      );
      CREATE INDEX IF NOT EXISTS social_connection_intents_owner_idx
        ON %1$I.social_connection_intents(user_id, platform, status);
      CREATE UNIQUE INDEX IF NOT EXISTS social_account_verified_external_uidx
        ON %1$I.social_accounts(zernio_account_id) WHERE publishing_verified_at IS NOT NULL;
    $ddl$, s);

    -- The HTTP disconnect owner may change operational flags only. Account
    -- identity and publishing evidence are written by the binding RPC; the
    -- completion time is assigned by the database trigger below.
    SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO column_names
      FROM pg_attribute WHERE attrelid = to_regclass(format('%I.social_accounts', s))
        AND attnum > 0 AND NOT attisdropped;
    EXECUTE format('REVOKE ALL ON TABLE %I.social_accounts FROM service_role', s);
    EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)
      ON TABLE %2$I.social_accounts FROM service_role', column_names, s);
    EXECUTE format('GRANT SELECT ON TABLE %I.social_accounts TO service_role', s);
    EXECUTE format('GRANT UPDATE (is_active, disconnect_pending, disconnect_reconcile_ready)
      ON TABLE %I.social_accounts TO service_role', s);
    EXECUTE format('REVOKE UPDATE (is_active, disconnect_pending, disconnect_reconcile_ready, disconnect_completed_at)
      ON TABLE %I.social_accounts FROM PUBLIC, anon, authenticated', s);

    FOREACH relation_name IN ARRAY ARRAY['social_profile_bindings', 'social_connection_intents'] LOOP
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', s, relation_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC, anon, authenticated', s, relation_name);
      SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) INTO column_names
        FROM pg_attribute WHERE attrelid = to_regclass(format('%I.%I', s, relation_name))
          AND attnum > 0 AND NOT attisdropped;
      EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)
        ON TABLE %2$I.%3$I FROM PUBLIC, anon, authenticated', column_names, s, relation_name);
      EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM service_role', s, relation_name);
      EXECUTE format('REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)
        ON TABLE %2$I.%3$I FROM service_role', column_names, s, relation_name);
      EXECUTE format('GRANT SELECT ON TABLE %I.%I TO service_role', s, relation_name);
      IF relation_name = 'social_profile_bindings' THEN
        EXECUTE format('GRANT UPDATE (creation_status, updated_at) ON TABLE %I.%I TO service_role', s, relation_name);
      ELSE
        EXECUTE format('GRANT UPDATE (status, consumed_at) ON TABLE %I.%I TO service_role', s, relation_name);
      END IF;
      EXECUTE format('DROP POLICY IF EXISTS social_binding_service ON %I.%I', s, relation_name);
      EXECUTE format('CREATE POLICY social_binding_service ON %I.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', s, relation_name);
    END LOOP;

    EXECUTE format($functions$
      CREATE OR REPLACE FUNCTION %1$I.social_account_identity_guard()
      RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          NEW.publishing_verified_at := NULL;
          NEW.disconnect_completed_at := NULL;
          NEW.disconnect_reconcile_ready := false;
        ELSIF ROW(NEW.user_id, NEW.platform, NEW.zernio_account_id, NEW.zernio_profile_id)
          IS DISTINCT FROM ROW(OLD.user_id, OLD.platform, OLD.zernio_account_id, OLD.zernio_profile_id) THEN
          NEW.publishing_verified_at := NULL;
          NEW.disconnect_reconcile_ready := false;
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.disconnect_pending AND NOT NEW.disconnect_pending THEN
          NEW.disconnect_completed_at := clock_timestamp();
        END IF;
        IF NOT NEW.disconnect_pending OR NEW.is_active IS DISTINCT FROM false OR
          (TG_OP = 'UPDATE' AND NOT OLD.disconnect_pending AND NEW.disconnect_pending) THEN
          NEW.disconnect_reconcile_ready := false;
        END IF;
        -- Readiness is a separate terminal marker: the request that acquired
        -- pending may set it only after it cannot issue a later DELETE. A new
        -- disconnect must never inherit readiness from an earlier operation.
        -- Keep identity evidence when only is_active becomes false. It is needed
        -- to reconcile an uncertain external DELETE; publishing also gates active.
        RETURN NEW;
      END;
      $fn$;
      DROP TRIGGER IF EXISTS social_account_identity_guard ON %1$I.social_accounts;
      CREATE TRIGGER social_account_identity_guard BEFORE INSERT OR UPDATE ON %1$I.social_accounts
        FOR EACH ROW EXECUTE FUNCTION %1$I.social_account_identity_guard();

      CREATE OR REPLACE FUNCTION %1$I.social_get_or_create_profile_binding(p_user_id uuid)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      DECLARE v_id uuid := gen_random_uuid(); v_row %1$I.social_profile_bindings%%ROWTYPE;
      BEGIN
        IF p_user_id IS NULL THEN RAISE EXCEPTION 'social_user_required'; END IF;
        INSERT INTO %1$I.social_profile_bindings(id, user_id, external_id, profile_name)
          VALUES (v_id, p_user_id, 'purama-ai:' || v_id::text, 'PURAMA ' || v_id::text)
          ON CONFLICT (user_id) DO NOTHING;
        SELECT * INTO STRICT v_row FROM %1$I.social_profile_bindings WHERE user_id = p_user_id;
        RETURN to_jsonb(v_row);
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION %1$I.social_claim_profile_creation(p_binding_id uuid)
      RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      BEGIN
        UPDATE %1$I.social_profile_bindings SET creation_status = 'creating', updated_at = clock_timestamp()
          WHERE id = p_binding_id AND creation_status = 'pending';
        RETURN FOUND;
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION %1$I.social_finish_profile_binding(p_binding_id uuid, p_profile_id text)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      DECLARE v_row %1$I.social_profile_bindings%%ROWTYPE;
      BEGIN
        IF p_profile_id IS NULL OR p_profile_id !~ '^[0-9a-f]{24}$' THEN RAISE EXCEPTION 'invalid_provider_profile'; END IF;
        SELECT * INTO STRICT v_row FROM %1$I.social_profile_bindings WHERE id = p_binding_id FOR UPDATE;
        IF v_row.creation_status = 'ready' AND v_row.zernio_profile_id <> p_profile_id THEN
          RAISE EXCEPTION 'profile_binding_already_fixed';
        END IF;
        UPDATE %1$I.social_profile_bindings SET zernio_profile_id = p_profile_id,
          creation_status = 'ready', updated_at = clock_timestamp() WHERE id = p_binding_id;
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION %1$I.social_begin_connection(
        p_user_id uuid, p_platform text, p_profile_id text, p_state_hash text,
        p_nonce uuid, p_issued_at timestamptz, p_expires_at timestamptz)
      RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      BEGIN
        IF p_user_id IS NULL OR p_platform IS NULL OR p_state_hash IS NULL OR p_nonce IS NULL OR
          p_issued_at IS NULL OR p_expires_at IS NULL OR p_expires_at <= clock_timestamp() OR
          p_issued_at > clock_timestamp() + interval '30 seconds' OR
          p_expires_at > p_issued_at + interval '10 minutes' THEN RAISE EXCEPTION 'invalid_connection_intent'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('social:' || p_user_id::text || ':' || p_platform, 0));
        PERFORM 1 FROM %1$I.social_profile_bindings
          WHERE user_id = p_user_id AND creation_status = 'ready' AND zernio_profile_id = p_profile_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'profile_binding_not_ready'; END IF;
        UPDATE %1$I.social_connection_intents SET status = 'superseded', consumed_at = clock_timestamp()
          WHERE user_id = p_user_id AND platform = p_platform AND status = 'pending';
        INSERT INTO %1$I.social_connection_intents(state_hash, nonce, user_id, platform, zernio_profile_id, issued_at, expires_at)
          VALUES (p_state_hash, p_nonce, p_user_id, p_platform, p_profile_id, p_issued_at, p_expires_at);
      END;
      $fn$;

      CREATE OR REPLACE FUNCTION %1$I.social_finish_connection(
        p_state_hash text, p_user_id uuid, p_platform text, p_profile_id text,
        p_account_id text, p_account_name text, p_account_username text)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
      DECLARE v_intent %1$I.social_connection_intents%%ROWTYPE; v_verified_at timestamptz;
        v_disconnect_pending boolean; v_disconnect_completed_at timestamptz;
      BEGIN
        IF p_user_id IS NULL OR p_platform IS NULL OR p_account_id IS NULL OR
          p_account_id !~ '^[0-9a-f]{24}$' THEN RAISE EXCEPTION 'invalid_account_binding'; END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('social:' || p_user_id::text || ':' || p_platform, 0));
        SELECT * INTO STRICT v_intent FROM %1$I.social_connection_intents WHERE state_hash = p_state_hash FOR UPDATE;
        IF v_intent.user_id <> p_user_id OR v_intent.platform <> p_platform OR
          p_profile_id IS NULL OR v_intent.zernio_profile_id <> p_profile_id THEN RAISE EXCEPTION 'callback_binding_mismatch'; END IF;
        IF v_intent.status = 'bound' THEN
          IF v_intent.zernio_account_id <> p_account_id THEN RAISE EXCEPTION 'social_state_replay_conflict'; END IF;
          RETURN jsonb_build_object('status', 'already_processed');
        END IF;
        IF v_intent.status <> 'pending' OR v_intent.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'social_state_closed'; END IF;
        PERFORM 1 FROM %1$I.social_profile_bindings
          WHERE user_id = p_user_id AND creation_status = 'ready' AND zernio_profile_id = p_profile_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'profile_binding_not_ready'; END IF;
        SELECT disconnect_pending, disconnect_completed_at
          INTO v_disconnect_pending, v_disconnect_completed_at FROM %1$I.social_accounts
          WHERE user_id = p_user_id AND platform = p_platform FOR UPDATE;
        IF FOUND AND (v_disconnect_pending OR
          (v_disconnect_completed_at IS NOT NULL AND v_intent.created_at <= v_disconnect_completed_at)) THEN
          RAISE EXCEPTION 'disconnect_requires_new_connection';
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('social-account:' || p_account_id, 0));
        IF EXISTS (SELECT 1 FROM %1$I.social_accounts WHERE zernio_account_id = p_account_id
          AND user_id <> p_user_id AND publishing_verified_at IS NOT NULL) THEN RAISE EXCEPTION 'account_already_bound'; END IF;

        INSERT INTO %1$I.social_accounts(user_id, platform, zernio_profile_id, zernio_account_id,
          account_name, account_username, is_active, connected_at)
          VALUES (p_user_id, p_platform, p_profile_id, p_account_id,
            left(coalesce(p_account_name, ''), 200), left(coalesce(p_account_username, ''), 200), true, clock_timestamp())
          ON CONFLICT (user_id, platform) DO UPDATE SET
            zernio_profile_id = EXCLUDED.zernio_profile_id, zernio_account_id = EXCLUDED.zernio_account_id,
            account_name = EXCLUDED.account_name, account_username = EXCLUDED.account_username,
            is_active = true, disconnect_reconcile_ready = false, connected_at = EXCLUDED.connected_at;
        -- The identity trigger cleared any inherited proof. Set fresh evidence
        -- only now, in the same transaction as nonce consumption and binding.
        v_verified_at := clock_timestamp();
        UPDATE %1$I.social_accounts SET publishing_verified_at = v_verified_at
          WHERE user_id = p_user_id AND platform = p_platform
            AND zernio_account_id = p_account_id AND zernio_profile_id = p_profile_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'account_binding_write_failed'; END IF;
        UPDATE %1$I.social_connection_intents SET status = 'bound', zernio_account_id = p_account_id,
          consumed_at = v_verified_at WHERE state_hash = p_state_hash;
        RETURN jsonb_build_object('status', 'bound');
      END;
      $fn$;

      REVOKE ALL ON FUNCTION %1$I.social_account_identity_guard(),
        %1$I.social_get_or_create_profile_binding(uuid), %1$I.social_claim_profile_creation(uuid),
        %1$I.social_finish_profile_binding(uuid,text),
        %1$I.social_begin_connection(uuid,text,text,text,uuid,timestamptz,timestamptz),
        %1$I.social_finish_connection(text,uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
      GRANT EXECUTE ON FUNCTION %1$I.social_account_identity_guard(),
        %1$I.social_get_or_create_profile_binding(uuid), %1$I.social_claim_profile_creation(uuid),
        %1$I.social_finish_profile_binding(uuid,text),
        %1$I.social_begin_connection(uuid,text,text,text,uuid,timestamptz,timestamptz),
        %1$I.social_finish_connection(text,uuid,text,text,text,text,text) TO service_role;
    $functions$, s);
  END LOOP;
  IF NOT found_schema THEN RAISE EXCEPTION 'No reviewed social_accounts table found'; END IF;
END;
$migration$;
COMMIT;

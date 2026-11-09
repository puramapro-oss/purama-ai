-- Financial values and payment/contract states are server-owned. Clients may
-- register an influencer profile, update beneficiary coordinates, and submit a
-- pending withdrawal request. This migration does not transfer funds, validate
-- historical balances, change commission rates, or reserve withdrawal amounts.
--
-- Historical influencers/commissions live in public; the application addresses
-- purama_ai. Harden either existing placement, without copying/moving tables.
-- public.wallet_transactions is a different V4.1 ledger and is out of scope.
BEGIN;

DO $commerce_privileges$
DECLARE
  target record;
  relation_oid regclass;
  target_relations text[] := ARRAY[]::text[];
  relation_name text;
  column_names text;
  required_columns text[];
  historical_policies text[];
  existing_policy record;
BEGIN
  -- Preflight and lock all existing relations before altering any privilege.
  -- Unknown policies or schema shapes need review rather than silent deletion.
  FOR target IN
    SELECT * FROM (VALUES
      ('public', 'influencers'), ('public', 'commissions'),
      ('purama_ai', 'influencers'), ('purama_ai', 'commissions'),
      ('purama_ai', 'wallets'), ('purama_ai', 'wallet_transactions'),
      ('purama_ai', 'withdrawals')
    ) AS targets(schema_name, table_name)
  LOOP
    relation_name := format('%I.%I', target.schema_name, target.table_name);
    relation_oid := to_regclass(relation_name);
    IF relation_oid IS NULL THEN
      RAISE NOTICE 'Commerce relation absent; not created: %', relation_name;
      CONTINUE;
    END IF;
    IF (SELECT relkind FROM pg_class WHERE oid = relation_oid) <> 'r' THEN
      RAISE EXCEPTION 'Unexpected commerce relation type: %', relation_name;
    END IF;
    EXECUTE format('LOCK TABLE %s IN ACCESS EXCLUSIVE MODE', relation_name);

    CASE target.table_name
      WHEN 'influencers' THEN
        required_columns := ARRAY['id', 'user_id', 'promo_code', 'affiliation_link',
          'commission_rate', 'total_revenue', 'total_sales', 'contract_status',
          'contract_signed_at', 'expires_at', 'iban', 'beneficiary_name'];
        historical_policies := ARRAY[
          'Influencers can view their own profile',
          'Influencers can update their own profile',
          'Influencers can insert their own profile',
          'Admins can view all influencers', 'Admins can update all influencers'];
      WHEN 'commissions' THEN
        required_columns := ARRAY['id', 'influencer_id', 'client_id', 'sale_amount',
          'commission_amount', 'status', 'payment_date'];
        historical_policies := ARRAY[
          'Influencers can view their own commissions', 'Admins can view all commissions',
          'Admins can update all commissions', 'Admins can insert commissions'];
      WHEN 'wallets' THEN
        required_columns := ARRAY['id', 'user_id', 'balance', 'total_earned', 'total_withdrawn'];
        historical_policies := ARRAY['wallet_own'];
      WHEN 'wallet_transactions' THEN
        required_columns := ARRAY['id', 'user_id', 'amount', 'type', 'source'];
        historical_policies := ARRAY['wallet_tx_own'];
      WHEN 'withdrawals' THEN
        required_columns := ARRAY['id', 'user_id', 'amount', 'iban', 'beneficiary_name',
          'status', 'requested_at', 'processed_at'];
        historical_policies := ARRAY['withdrawal_own'];
    END CASE;

    IF EXISTS (
      SELECT 1 FROM unnest(required_columns) AS required(column_name)
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = relation_oid AND attname = required.column_name
          AND attnum > 0 AND NOT attisdropped
      )
    ) THEN
      RAISE EXCEPTION 'Unexpected commerce columns: %', relation_name;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policy
      WHERE polrelid = relation_oid AND NOT (
        polname = ANY(historical_policies || ARRAY['commerce_client_read',
          'commerce_client_insert', 'commerce_client_update', 'commerce_server_write'])
      )
    ) THEN
      RAISE EXCEPTION 'Unexpected commerce policies: %', relation_name;
    END IF;
    target_relations := array_append(target_relations, relation_name);
  END LOOP;

  IF cardinality(target_relations) = 0 THEN
    RAISE EXCEPTION 'No reviewed commerce tables found in public or purama_ai';
  END IF;

  FOREACH relation_name IN ARRAY target_relations LOOP
    relation_oid := to_regclass(relation_name);
    SELECT n.nspname AS schema_name, c.relname AS table_name INTO target
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = relation_oid;
    SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO column_names
      FROM pg_attribute WHERE attrelid = relation_oid AND attnum > 0 AND NOT attisdropped;

    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC, anon, authenticated', relation_name);
    -- Table revocation alone leaves independently granted column privileges.
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s)
       ON TABLE %2$s FROM PUBLIC, anon, authenticated', column_names, relation_name
    );
    EXECUTE format('GRANT SELECT ON TABLE %s TO authenticated', relation_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO service_role', relation_name);

    FOR existing_policy IN SELECT polname FROM pg_policy WHERE polrelid = relation_oid LOOP
      EXECUTE format('DROP POLICY %I ON %s', existing_policy.polname, relation_name);
    END LOOP;
    EXECUTE format(
      'CREATE POLICY commerce_server_write ON %s FOR ALL TO service_role
       USING (true) WITH CHECK (true)', relation_name
    );

    IF target.table_name = 'influencers' THEN
      EXECUTE format(
        'GRANT INSERT (user_id, promo_code, affiliation_link, iban, beneficiary_name),
         UPDATE (iban, beneficiary_name) ON TABLE %s TO authenticated', relation_name
      );
      EXECUTE format(
        'CREATE POLICY commerce_client_read ON %s FOR SELECT TO authenticated
         USING (user_id = (SELECT auth.uid())
           OR public.has_role((SELECT auth.uid()), ''admin''::public.app_role))', relation_name
      );
      EXECUTE format(
        'CREATE POLICY commerce_client_insert ON %s FOR INSERT TO authenticated
         WITH CHECK (user_id = (SELECT auth.uid()))', relation_name
      );
      EXECUTE format(
        'CREATE POLICY commerce_client_update ON %s FOR UPDATE TO authenticated
         USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()))', relation_name
      );
    ELSIF target.table_name = 'commissions' THEN
      EXECUTE format(
        'CREATE POLICY commerce_client_read ON %s FOR SELECT TO authenticated
         USING (EXISTS (SELECT 1 FROM %I.influencers i
           WHERE i.id = commissions.influencer_id AND i.user_id = (SELECT auth.uid()))
           OR public.has_role((SELECT auth.uid()), ''admin''::public.app_role))',
        relation_name, target.schema_name
      );
    ELSE
      EXECUTE format(
        'CREATE POLICY commerce_client_read ON %s FOR SELECT TO authenticated
         USING (user_id = (SELECT auth.uid()))', relation_name
      );
      IF target.table_name = 'withdrawals' THEN
        EXECUTE format(
          'GRANT INSERT (user_id, amount, iban, beneficiary_name)
           ON TABLE %s TO authenticated', relation_name
        );
        EXECUTE format(
          'CREATE POLICY commerce_client_insert ON %s FOR INSERT TO authenticated
           WITH CHECK (user_id = (SELECT auth.uid()) AND status = ''pending''
             AND processed_at IS NULL)', relation_name
        );
      END IF;
    END IF;
  END LOOP;
END
$commerce_privileges$;

COMMIT;

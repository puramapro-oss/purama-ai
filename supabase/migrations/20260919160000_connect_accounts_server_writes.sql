-- Stripe account IDs and KYC/payout state are server-managed authorization data.
-- The UI only reads this table; connect-account-session writes with service_role.
-- Review existing mappings against Stripe before rollout: permissions do not
-- establish the provenance of rows created before this migration.
BEGIN;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.connect_accounts FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "users see own connect" ON public.connect_accounts;
DROP POLICY IF EXISTS "users read own connect" ON public.connect_accounts;
CREATE POLICY "users read own connect" ON public.connect_accounts FOR SELECT
  TO authenticated USING (auth.uid() = user_id);
GRANT SELECT ON public.connect_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connect_accounts TO service_role;
COMMIT;

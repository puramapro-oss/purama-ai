-- The V4.1 payment helpers run with their owner's privileges. Granting EXECUTE
-- to service_role in the original migration did not remove PostgreSQL's default
-- PUBLIC grant or any explicit grants previously given to browser roles.
-- Restrict only these three existing signatures; keep server callers authorized.
-- No function body, owner, table policy, or financial record is changed.

REVOKE ALL ON FUNCTION
  public.increment_wallet_balance(uuid, numeric),
  public.prime_mark_payment(uuid, text),
  public.prime_suspend_payment(uuid, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.increment_wallet_balance(uuid, numeric),
  public.prime_mark_payment(uuid, text),
  public.prime_suspend_payment(uuid, text)
TO service_role;

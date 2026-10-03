-- P0 security hardening: close anonymous cross-tenant access and privileged RPCs.
-- This migration is intentionally additive; historical migrations remain immutable.

-- -----------------------------------------------------------------------------
-- Notifications
-- service_role bypasses RLS and must not be inferred from auth.uid() IS NULL,
-- because the anon role also has a NULL auth.uid().
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role can insert notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users can insert their own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users and service role can insert notifications" ON public.notifications;

REVOKE INSERT ON public.notifications FROM anon;
GRANT INSERT ON public.notifications TO authenticated;

CREATE POLICY "Authenticated users can insert their own notifications"
ON public.notifications
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL AND auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- Support chat
-- Anonymous rows were previously readable and writable by every anonymous or
-- authenticated caller. Direct table access is now authenticated and owner-only.
-- Public chat traffic must go through a server-side Edge Function using a
-- server-validated opaque session token rather than trusting session_id in RLS.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users can view own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Anyone can create conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can update own conversations" ON public.chat_conversations;
DROP POLICY IF EXISTS "Users can view messages of their conversations" ON public.chat_messages;
DROP POLICY IF EXISTS "Anyone can insert messages" ON public.chat_messages;

REVOKE ALL ON public.chat_conversations FROM anon;
REVOKE ALL ON public.chat_messages FROM anon;

CREATE POLICY "Authenticated users can view own conversations"
ON public.chat_conversations
FOR SELECT
TO authenticated
USING (auth.uid() IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "Authenticated users can create own conversations"
ON public.chat_conversations
FOR INSERT
TO authenticated
WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "Authenticated users can update own conversations"
ON public.chat_conversations
FOR UPDATE
TO authenticated
USING (auth.uid() IS NOT NULL AND user_id = auth.uid())
WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "Authenticated users can view own conversation messages"
ON public.chat_messages
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.chat_conversations AS conversation
    WHERE conversation.id = chat_messages.conversation_id
      AND auth.uid() IS NOT NULL
      AND conversation.user_id = auth.uid()
  )
);

CREATE POLICY "Authenticated users can insert own conversation messages"
ON public.chat_messages
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.chat_conversations AS conversation
    WHERE conversation.id = chat_messages.conversation_id
      AND auth.uid() IS NOT NULL
      AND conversation.user_id = auth.uid()
  )
);

-- -----------------------------------------------------------------------------
-- Privileged SECURITY DEFINER RPCs
-- PostgreSQL grants EXECUTE to PUBLIC by default. Restrict these administrative
-- routines explicitly and pin a safe search_path to prevent object shadowing.
-- -----------------------------------------------------------------------------
ALTER FUNCTION purama_ai.anonymize_contract_user(uuid)
  SET search_path = pg_catalog, purama_ai, extensions, pg_temp;
REVOKE ALL ON FUNCTION purama_ai.anonymize_contract_user(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.anonymize_contract_user(uuid)
  TO service_role;

ALTER FUNCTION purama_ai.cron_auto_cancel_stale_contracts()
  SET search_path = pg_catalog, purama_ai, pg_temp;
REVOKE ALL ON FUNCTION purama_ai.cron_auto_cancel_stale_contracts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.cron_auto_cancel_stale_contracts()
  TO service_role;

ALTER FUNCTION purama_ai.cron_reminder_stale_contracts()
  SET search_path = pg_catalog, purama_ai, pg_temp;
REVOKE ALL ON FUNCTION purama_ai.cron_reminder_stale_contracts()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.cron_reminder_stale_contracts()
  TO service_role;

ALTER FUNCTION purama_ai.cron_weekly_contracts_report()
  SET search_path = pg_catalog, purama_ai, pg_temp;
REVOKE ALL ON FUNCTION purama_ai.cron_weekly_contracts_report()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.cron_weekly_contracts_report()
  TO service_role;

-- Anonymous widget conversations stay in browser memory. Stored history is
-- owner-only; existing anonymous rows are retained for administrative handling.
-- Older migrations use public, while the current client uses purama_ai. Harden
-- every complete pair that exists, without moving or creating either table.
BEGIN;

DO $chat_history$
DECLARE
  target_schema text;
  target_schemas text[] := ARRAY[]::text[];
  conversations_oid regclass;
  messages_oid regclass;
BEGIN
  -- Preflight every schema before changing any ACL or policy. Unknown policies
  -- can combine permissively with these policies, so do not silently retain them.
  FOREACH target_schema IN ARRAY ARRAY['public', 'purama_ai'] LOOP
    conversations_oid := to_regclass(format('%I.chat_conversations', target_schema));
    messages_oid := to_regclass(format('%I.chat_messages', target_schema));

    IF conversations_oid IS NULL AND messages_oid IS NULL THEN
      CONTINUE;
    END IF;
    IF conversations_oid IS NULL OR messages_oid IS NULL THEN
      RAISE EXCEPTION 'Incomplete chat history schema: %', target_schema;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid IN (conversations_oid, messages_oid) AND relkind <> 'r'
    ) THEN
      RAISE EXCEPTION 'Unexpected chat history relation type in schema: %', target_schema;
    END IF;

    -- Keep the reviewed policy set stable until commit, including against
    -- concurrent CREATE POLICY or table changes during a real migration.
    EXECUTE format(
      'LOCK TABLE %I.chat_conversations, %I.chat_messages IN ACCESS EXCLUSIVE MODE',
      target_schema, target_schema
    );

    IF (SELECT count(*) FROM pg_policy WHERE polrelid = conversations_oid) <> 3
      OR EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = conversations_oid AND (
          NOT polpermissive OR NOT (
            (polname = 'Users can view own conversations' AND polcmd = 'r') OR
            (polname = 'Anyone can create conversations' AND polcmd = 'a') OR
            (polname = 'Users can update own conversations' AND polcmd = 'w')
          )
        )
      ) THEN
      RAISE EXCEPTION 'Unexpected chat_conversations policies in schema: %', target_schema;
    END IF;
    IF (SELECT count(*) FROM pg_policy WHERE polrelid = messages_oid) <> 2
      OR EXISTS (
        SELECT 1 FROM pg_policy
        WHERE polrelid = messages_oid AND (
          NOT polpermissive OR NOT (
            (polname = 'Users can view messages of their conversations' AND polcmd = 'r') OR
            (polname = 'Anyone can insert messages' AND polcmd = 'a')
          )
        )
      ) THEN
      RAISE EXCEPTION 'Unexpected chat_messages policies in schema: %', target_schema;
    END IF;
    target_schemas := array_append(target_schemas, target_schema);
  END LOOP;

  IF cardinality(target_schemas) = 0 THEN
    RAISE EXCEPTION 'No chat history tables found in public or purama_ai';
  END IF;

  FOREACH target_schema IN ARRAY target_schemas LOOP
    EXECUTE format('ALTER TABLE %I.chat_conversations ENABLE ROW LEVEL SECURITY', target_schema);
    EXECUTE format('ALTER TABLE %I.chat_messages ENABLE ROW LEVEL SECURITY', target_schema);
    EXECUTE format(
      'REVOKE ALL ON TABLE %I.chat_conversations, %I.chat_messages FROM PUBLIC, anon, authenticated',
      target_schema, target_schema
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I.chat_conversations TO authenticated', target_schema);
    EXECUTE format('GRANT SELECT, INSERT ON %I.chat_messages TO authenticated', target_schema);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.chat_conversations, %I.chat_messages TO service_role',
      target_schema, target_schema
    );

    -- Retain the five historical names to make reapplication deterministic.
    EXECUTE format(
      'ALTER POLICY "Users can view own conversations" ON %I.chat_conversations TO authenticated
       USING (user_id = (SELECT auth.uid()))', target_schema
    );
    EXECUTE format(
      'ALTER POLICY "Anyone can create conversations" ON %I.chat_conversations TO authenticated
       WITH CHECK (user_id = (SELECT auth.uid()))', target_schema
    );
    EXECUTE format(
      'ALTER POLICY "Users can update own conversations" ON %I.chat_conversations TO authenticated
       USING (user_id = (SELECT auth.uid())) WITH CHECK (user_id = (SELECT auth.uid()))', target_schema
    );
    EXECUTE format(
      'ALTER POLICY "Users can view messages of their conversations" ON %I.chat_messages TO authenticated
       USING (EXISTS (SELECT 1 FROM %I.chat_conversations c
         WHERE c.id = chat_messages.conversation_id AND c.user_id = (SELECT auth.uid())))',
      target_schema, target_schema
    );
    -- The current widget persists both user text and completed assistant text.
    -- This ownership check does not establish the provenance of assistant text.
    EXECUTE format(
      'ALTER POLICY "Anyone can insert messages" ON %I.chat_messages TO authenticated
       WITH CHECK (role IN (''user'', ''assistant'') AND EXISTS (
         SELECT 1 FROM %I.chat_conversations c
         WHERE c.id = chat_messages.conversation_id AND c.user_id = (SELECT auth.uid())))',
      target_schema, target_schema
    );
  END LOOP;
END
$chat_history$;

COMMIT;

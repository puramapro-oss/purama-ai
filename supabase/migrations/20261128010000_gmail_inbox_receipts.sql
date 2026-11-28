-- Receipt references and Gmail identifiers only. Bodies and exclusion lists stay out of this queue.
BEGIN;

ALTER TABLE purama_ai.email_agent_config ADD COLUMN IF NOT EXISTS gmail_inbox_policy_version uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE purama_ai.email_agent_config ADD COLUMN IF NOT EXISTS gmail_inbox_page_token text;
ALTER TABLE purama_ai.email_agent_config ADD COLUMN IF NOT EXISTS gmail_inbox_scan_started_at timestamptz;
CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_policy_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF lower(btrim(NEW.gmail_email)) IS DISTINCT FROM lower(btrim(OLD.gmail_email)) THEN
    NEW.last_sync_at := NULL;
    NEW.last_email_id := NULL;
    NEW.gmail_inbox_page_token := NULL;
    NEW.gmail_inbox_scan_started_at := NULL;
  END IF;
  -- OAuth refreshes and ordinary cursor/counter writes do not invalidate a claim.
  IF ROW(NEW.gmail_email,NEW.is_active,NEW.excluded_emails,NEW.excluded_domains,NEW.autonomy_level,
    NEW.tone,NEW.custom_tone_prompt,NEW.signature,NEW.language,NEW.auto_reply_categories,NEW.notify_categories,
    NEW.archive_categories,NEW.working_hours_only,NEW.working_hours_start,NEW.working_hours_end,
    NEW.vacation_mode,NEW.vacation_message)
    IS DISTINCT FROM ROW(OLD.gmail_email,OLD.is_active,OLD.excluded_emails,OLD.excluded_domains,OLD.autonomy_level,
    OLD.tone,OLD.custom_tone_prompt,OLD.signature,OLD.language,OLD.auto_reply_categories,OLD.notify_categories,
    OLD.archive_categories,OLD.working_hours_only,OLD.working_hours_start,OLD.working_hours_end,
    OLD.vacation_mode,OLD.vacation_message) THEN
    NEW.gmail_inbox_policy_version := gen_random_uuid();
  ELSE
    NEW.gmail_inbox_policy_version := OLD.gmail_inbox_policy_version;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS gmail_inbox_policy_change ON purama_ai.email_agent_config;
CREATE TRIGGER gmail_inbox_policy_change BEFORE UPDATE ON purama_ai.email_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.gmail_inbox_policy_change();

-- The pre-existing manual draft preview binds to config.updated_at. A polling
-- checkpoint alone is not a credential or policy edit. Other tables retain
-- their existing shared trigger, and future configuration columns count as edits.
CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_config_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE checkpoint_fields constant text[]:=ARRAY['updated_at','last_sync_at','last_email_id','gmail_inbox_page_token','gmail_inbox_scan_started_at'];
BEGIN
  IF to_jsonb(NEW)-checkpoint_fields IS NOT DISTINCT FROM to_jsonb(OLD)-checkpoint_fields THEN
    NEW.updated_at:=OLD.updated_at;
  ELSE
    NEW.updated_at:=greatest(clock_timestamp(),OLD.updated_at+interval '1 microsecond');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_email_agent_config_updated ON purama_ai.email_agent_config;
CREATE TRIGGER trg_email_agent_config_updated BEFORE UPDATE ON purama_ai.email_agent_config
  FOR EACH ROW EXECUTE FUNCTION purama_ai.gmail_inbox_config_stamp();

-- Distinguish genuine pre-migration approvals from unbound actions produced by an outdated worker.
CREATE TABLE IF NOT EXISTS purama_ai.gmail_inbox_activation (
  singleton boolean PRIMARY KEY CHECK (singleton), enabled_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO purama_ai.gmail_inbox_activation(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE purama_ai.gmail_inbox_activation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.gmail_inbox_activation FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE IF NOT EXISTS purama_ai.gmail_inbox_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mailbox text NOT NULL,
  message_id text NOT NULL CHECK (octet_length(message_id) BETWEEN 1 AND 256 AND message_id !~ '[^A-Za-z0-9_-]'),
  thread_id text NOT NULL CHECK (octet_length(thread_id) BETWEEN 1 AND 256 AND thread_id !~ '[^A-Za-z0-9_-]'),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','claimed','armed','review','followup','done','ignored','observed','closed_without_retry')),
  run_id uuid, agent_type text, config_id uuid, policy_version uuid,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), claimed_until timestamptz, review_at timestamptz, reference text, resolution_reference text,
  followup_tools text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id,mailbox,message_id)
);
CREATE INDEX IF NOT EXISTS gmail_inbox_take ON purama_ai.gmail_inbox_items(user_id,mailbox,available_at,id) WHERE state IN ('ready','claimed');
CREATE INDEX IF NOT EXISTS gmail_inbox_review ON purama_ai.gmail_inbox_items(user_id,created_at DESC,id DESC) WHERE state IN ('review','followup','armed') OR (state='done' AND reference LIKE 'approval:%');

-- Preserve completed run ownership even when a pre-effect item becomes retryable.
CREATE TABLE IF NOT EXISTS purama_ai.gmail_inbox_attempts (
  run_id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES purama_ai.gmail_inbox_items(id) ON DELETE CASCADE
);
ALTER TABLE purama_ai.gmail_inbox_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.gmail_inbox_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON purama_ai.gmail_inbox_items, purama_ai.gmail_inbox_attempts FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_capture(p_user_id uuid,p_config_id uuid,
  p_config_updated_at timestamptz,p_previous_cursor timestamptz,p_sync_started_at timestamptz,p_messages jsonb,
  p_previous_page_token text DEFAULT NULL,p_next_page_token text DEFAULT NULL,p_restart_scan boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg purama_ai.email_agent_config%rowtype; mailbox_key text; msg jsonb;
BEGIN
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id AND id=p_config_id FOR UPDATE;
  IF cfg.id IS NULL OR cfg.is_active IS NOT TRUE OR nullif(btrim(cfg.gmail_email),'') IS NULL
    OR cfg.updated_at IS DISTINCT FROM p_config_updated_at OR cfg.last_sync_at IS DISTINCT FROM p_previous_cursor
    OR cfg.gmail_inbox_page_token IS DISTINCT FROM p_previous_page_token
    OR (p_previous_page_token IS NOT NULL AND cfg.gmail_inbox_scan_started_at IS DISTINCT FROM p_sync_started_at)
    OR p_sync_started_at IS NULL OR NOT isfinite(p_sync_started_at) OR p_sync_started_at < cfg.last_sync_at
    OR p_sync_started_at > clock_timestamp() + interval '5 minutes' THEN
    RETURN jsonb_build_object('status','stale');
  END IF;
  IF jsonb_typeof(p_messages) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid Gmail item batch'; END IF;
  IF jsonb_array_length(p_messages)>50 OR p_restart_scan IS NULL THEN RAISE EXCEPTION 'invalid Gmail item batch'; END IF;
  IF p_restart_scan THEN
    IF p_previous_page_token IS NULL OR p_next_page_token IS NOT NULL OR jsonb_array_length(p_messages)<>0 THEN
      RETURN jsonb_build_object('status','stale');
    END IF;
    UPDATE purama_ai.email_agent_config SET gmail_inbox_page_token=NULL,gmail_inbox_scan_started_at=NULL WHERE id=cfg.id;
    RETURN jsonb_build_object('status','captured');
  END IF;
  IF p_next_page_token IS NOT NULL AND (octet_length(p_next_page_token) NOT BETWEEN 1 AND 4096
    OR p_next_page_token ~ '[[:cntrl:]]' OR p_next_page_token=p_previous_page_token) THEN
    RAISE EXCEPTION 'invalid Gmail page token';
  END IF;
  mailbox_key:=lower(btrim(cfg.gmail_email));
  FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
    IF jsonb_typeof(msg) IS DISTINCT FROM 'object' OR jsonb_typeof(msg->'id') IS DISTINCT FROM 'string'
      OR jsonb_typeof(msg->'threadId') IS DISTINCT FROM 'string' OR msg-'id'-'threadId' <> '{}'::jsonb
      OR octet_length(msg->>'id') NOT BETWEEN 1 AND 256 OR octet_length(msg->>'threadId') NOT BETWEEN 1 AND 256
      OR (msg->>'id') ~ '[^A-Za-z0-9_-]' OR (msg->>'threadId') ~ '[^A-Za-z0-9_-]'
      THEN RAISE EXCEPTION 'invalid Gmail item identity'; END IF;
    INSERT INTO purama_ai.gmail_inbox_items(user_id,mailbox,message_id,thread_id)
      VALUES(p_user_id,mailbox_key,msg->>'id',msg->>'threadId') ON CONFLICT(user_id,mailbox,message_id) DO NOTHING;
    IF NOT EXISTS(SELECT FROM purama_ai.gmail_inbox_items WHERE user_id=p_user_id AND mailbox=mailbox_key
      AND message_id=msg->>'id' AND thread_id=msg->>'threadId') THEN RAISE EXCEPTION 'conflicting Gmail thread identity'; END IF;
  END LOOP;
  UPDATE purama_ai.email_agent_config SET
    last_sync_at=CASE WHEN p_next_page_token IS NULL THEN p_sync_started_at ELSE last_sync_at END,
    gmail_inbox_page_token=p_next_page_token,gmail_inbox_scan_started_at=CASE WHEN p_next_page_token IS NOT NULL THEN p_sync_started_at END,
    last_email_id=coalesce(p_messages->0->>'id',last_email_id) WHERE id=cfg.id;
  RETURN jsonb_build_object('status','captured');
END $$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_claim(p_user_id uuid,p_config_id uuid,p_run_id uuid,p_agent_type text,p_policy_version uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg purama_ai.email_agent_config%rowtype; item purama_ai.gmail_inbox_items%rowtype;
BEGIN
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE id=p_config_id AND user_id=p_user_id FOR UPDATE;
  IF cfg.id IS NULL OR cfg.is_active IS NOT TRUE OR nullif(btrim(cfg.gmail_email),'') IS NULL
    OR cfg.gmail_inbox_policy_version IS DISTINCT FROM p_policy_version OR p_agent_type IS NULL OR p_agent_type NOT IN ('email','repondeur-intelligent')
    OR NOT EXISTS (SELECT FROM purama_ai.karta_runs WHERE id=p_run_id AND user_id=p_user_id AND agent_type=p_agent_type AND mode='live' AND status='running')
    OR EXISTS (SELECT FROM purama_ai.gmail_inbox_attempts WHERE run_id=p_run_id) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO item FROM purama_ai.gmail_inbox_items WHERE user_id=p_user_id AND mailbox=lower(btrim(cfg.gmail_email))
    AND ((state='ready' AND available_at<=clock_timestamp()) OR (state='claimed' AND claimed_until<=clock_timestamp()))
    ORDER BY available_at,id LIMIT 1 FOR UPDATE;
  IF item.id IS NULL THEN RETURN jsonb_build_object('status','empty'); END IF;
  INSERT INTO purama_ai.gmail_inbox_attempts(run_id,item_id) VALUES(p_run_id,item.id);
  UPDATE purama_ai.gmail_inbox_items SET state='claimed',run_id=p_run_id,agent_type=p_agent_type,config_id=cfg.id,
    policy_version=cfg.gmail_inbox_policy_version,claimed_until=clock_timestamp()+interval '10 minutes'
    WHERE id=item.id;
  RETURN jsonb_build_object('status','claimed','item_id',item.id,'message_id',item.message_id,'thread_id',item.thread_id,
    'mailbox',item.mailbox,'policy_version',cfg.gmail_inbox_policy_version);
END $$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_begin(p_user_id uuid,p_item_id uuid,p_run_id uuid,p_policy_version uuid,p_followup_tools text[] DEFAULT ARRAY[]::text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg purama_ai.email_agent_config%rowtype; item purama_ai.gmail_inbox_items%rowtype;
BEGIN
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.gmail_inbox_items WHERE id=p_item_id AND user_id=p_user_id FOR UPDATE;
  IF cfg.id IS NULL OR cfg.is_active IS NOT TRUE OR item.id IS NULL OR item.config_id IS DISTINCT FROM cfg.id
    OR item.mailbox IS DISTINCT FROM lower(btrim(cfg.gmail_email)) OR item.policy_version IS DISTINCT FROM cfg.gmail_inbox_policy_version
    OR item.policy_version IS DISTINCT FROM p_policy_version OR item.run_id IS DISTINCT FROM p_run_id OR item.state<>'claimed'
    OR item.claimed_until<=clock_timestamp() OR NOT EXISTS(SELECT FROM purama_ai.karta_runs WHERE id=p_run_id
      AND user_id=p_user_id AND agent_type=item.agent_type AND mode='live' AND status='running') THEN
    RETURN jsonb_build_object('status','blocked');
  END IF;
  IF p_followup_tools IS NULL OR cardinality(p_followup_tools)>32 OR coalesce(array_ndims(p_followup_tools),1)<>1
    OR EXISTS(SELECT FROM unnest(p_followup_tools) t WHERE t IS NULL OR t NOT IN ('gmail_send','gmail_create_draft','send_notification'))
    THEN RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE purama_ai.gmail_inbox_items SET state='armed',
    followup_tools=ARRAY(SELECT t FROM unnest(p_followup_tools) WITH ORDINALITY x(t,n) GROUP BY t ORDER BY min(n)),claimed_until=clock_timestamp()+interval '10 minutes' WHERE id=item.id;
  RETURN jsonb_build_object('status','armed');
END $$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_finish(p_user_id uuid,p_item_id uuid,p_run_id uuid,p_outcome text,p_reference text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg purama_ai.email_agent_config%rowtype; item purama_ai.gmail_inbox_items%rowtype; next_state text;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('complete','retry','unknown','ignored')
    OR (p_reference IS NOT NULL AND (length(split_part(p_reference,':',2))>256 OR p_reference !~ '^(message|draft|approval|notification):[A-Za-z0-9_-]+$'))
    THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id FOR UPDATE;
  SELECT * INTO item FROM purama_ai.gmail_inbox_items WHERE id=p_item_id AND user_id=p_user_id FOR UPDATE;
  IF item.id IS NULL OR item.run_id IS DISTINCT FROM p_run_id OR p_run_id IS NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  -- A lost database acknowledgement is safe to read again, never to re-arm.
  IF item.state IN ('done','ready','review','followup','ignored','observed','closed_without_retry') THEN
    RETURN jsonb_build_object('status',CASE WHEN item.state='followup' THEN 'review' ELSE item.state END);
  END IF;
  IF item.state='claimed' AND p_outcome='complete' THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF p_outcome='unknown' OR (item.state='armed' AND (p_outcome<>'complete' OR p_reference IS NULL)) THEN next_state:='review';
  ELSIF item.state='claimed' AND (p_outcome='retry' OR item.claimed_until<=clock_timestamp()
    OR cfg.id IS NULL OR cfg.is_active IS NOT TRUE OR cfg.id IS DISTINCT FROM item.config_id
    OR item.policy_version IS DISTINCT FROM cfg.gmail_inbox_policy_version) THEN next_state:='ready';
  ELSIF item.state='armed' AND cardinality(item.followup_tools)>0 THEN next_state:='followup';
  ELSIF p_outcome='ignored' THEN next_state:='ignored';
  ELSE next_state:='done';
  END IF;
  UPDATE purama_ai.gmail_inbox_items SET state=next_state,claimed_until=NULL,
    available_at=CASE WHEN next_state='ready' AND p_outcome='retry' THEN clock_timestamp()+interval '45 seconds' ELSE available_at END,
    review_at=CASE WHEN next_state IN ('review','followup') THEN clock_timestamp() ELSE NULL END,reference=p_reference WHERE id=item.id;
  RETURN jsonb_build_object('status',CASE WHEN next_state='followup' THEN 'review' ELSE next_state END);
END $$;

-- Called only after KARTA's existing authenticated approval claim. No admission based on a caller-supplied run alone.
CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_approval_binding(p_user_id uuid,p_run_id uuid,p_approval_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cfg purama_ai.email_agent_config%rowtype; item purama_ai.gmail_inbox_items%rowtype;
  pending record; parent record; matches integer;
BEGIN
  SELECT * INTO parent FROM purama_ai.karta_runs WHERE id=p_run_id AND user_id=p_user_id;
  SELECT * INTO pending FROM purama_ai.karta_pending_actions WHERE id=p_approval_id AND user_id=p_user_id AND run_id=p_run_id;
  IF parent.id IS NULL OR pending.id IS NULL OR pending.agent_type NOT IN ('email','repondeur-intelligent')
    OR pending.agent_type IS DISTINCT FROM parent.agent_type OR parent.mode<>'live' OR parent.claude_mock IS NOT FALSE
    OR parent.status='running' OR jsonb_typeof(parent.tools_used) IS DISTINCT FROM 'array' OR pending.status<>'executing' THEN
    RETURN jsonb_build_object('status','blocked');
  END IF;
  SELECT count(*) INTO matches FROM jsonb_array_elements(parent.tools_used) e WHERE e->>'pendingActionId'=p_approval_id::text
    AND e->>'tool'=pending.tool_name AND e->>'outcome'='pending' AND e->'success'='false'::jsonb;
  IF matches<>1 THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT i.* INTO item FROM purama_ai.gmail_inbox_attempts a JOIN purama_ai.gmail_inbox_items i ON i.id=a.item_id WHERE a.run_id=p_run_id;
  IF item.id IS NULL THEN
    IF EXISTS (SELECT FROM purama_ai.gmail_inbox_activation WHERE singleton AND parent.started_at<=enabled_at AND pending.created_at<=enabled_at)
      THEN RETURN jsonb_build_object('status','legacy'); END IF;
    RETURN jsonb_build_object('status','blocked');
  END IF;
  SELECT * INTO cfg FROM purama_ai.email_agent_config WHERE user_id=p_user_id;
  IF item.run_id IS DISTINCT FROM p_run_id OR item.user_id IS DISTINCT FROM p_user_id OR item.agent_type IS DISTINCT FROM pending.agent_type
    OR item.state NOT IN ('done','followup') OR item.reference IS DISTINCT FROM 'approval:'||p_approval_id::text OR cfg.id IS DISTINCT FROM item.config_id
    OR cfg.is_active IS NOT TRUE OR cfg.gmail_inbox_policy_version IS DISTINCT FROM item.policy_version
    OR lower(btrim(cfg.gmail_email)) IS DISTINCT FROM item.mailbox
    OR pending.tool_name NOT IN ('gmail_send','gmail_create_draft','send_notification')
    OR (pending.tool_name IN ('gmail_send','gmail_create_draft') AND (pending.tool_params->>'replyToMessageId' IS DISTINCT FROM item.message_id
      OR pending.tool_params->>'threadId' IS DISTINCT FROM item.thread_id)) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  RETURN jsonb_build_object('status','bound','mailbox',item.mailbox,'policy_version',item.policy_version,'message_id',item.message_id,'thread_id',item.thread_id);
END $$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_approval_review_at(p_status text,p_claim timestamptz,p_resolution timestamptz,p_creation timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN p_status='failed' THEN coalesce(p_resolution,p_claim,p_creation)
    WHEN p_status='executing' AND p_claim+interval '10 minutes'<=statement_timestamp() THEN p_claim+interval '10 minutes' END
$$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_reviews(p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid:=auth.uid(); anchor purama_ai.gmail_inbox_items%rowtype; page jsonb; next_id uuid;
BEGIN
  IF owner_id IS NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF p_before_id IS NOT NULL THEN
    SELECT * INTO anchor FROM purama_ai.gmail_inbox_items WHERE id=p_before_id AND user_id=owner_id;
    IF anchor.id IS NULL THEN RETURN jsonb_build_object('status','blocked'); END IF;
  END IF;
  WITH candidates AS MATERIALIZED (
    SELECT i.*,d.deferred_at FROM purama_ai.gmail_inbox_items i
      LEFT JOIN purama_ai.karta_pending_actions a ON i.state='done' AND a.run_id=i.run_id AND a.user_id=i.user_id
        AND a.agent_type=i.agent_type AND i.reference='approval:'||a.id::text
      CROSS JOIN LATERAL (SELECT purama_ai.gmail_inbox_approval_review_at(a.status,a.claimed_at,a.resolved_at,a.created_at) deferred_at) d
      WHERE i.user_id=owner_id AND (i.state IN ('review','followup') OR (i.state='armed' AND i.claimed_until<=clock_timestamp()) OR d.deferred_at IS NOT NULL)
      AND (p_before_id IS NULL OR (i.created_at,i.id)<(anchor.created_at,anchor.id))
      ORDER BY i.created_at DESC,i.id DESC LIMIT 31
  ), shown AS (
    SELECT * FROM candidates ORDER BY created_at DESC,id DESC LIMIT 30
  ) SELECT coalesce(jsonb_agg(jsonb_build_object('item_id',id,'mailbox',mailbox,'message_id',message_id,'thread_id',thread_id,
    'agent_type',agent_type,'run_id',run_id,'created_at',created_at,'review_at',coalesce(review_at,claimed_until,deferred_at),
    'reference',reference,'followup_tools',followup_tools) ORDER BY created_at DESC,id DESC),'[]'::jsonb),
    CASE WHEN (SELECT count(*) FROM candidates)>30 THEN (array_agg(id ORDER BY created_at,id))[1] END INTO page,next_id FROM shown;
  RETURN jsonb_build_object('status','ok','items',page,'next_before_id',next_id);
END $$;

CREATE OR REPLACE FUNCTION purama_ai.gmail_inbox_resolve(p_item_id uuid,p_resolution text,p_reference text,p_expected_mailbox text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE owner_id uuid:=auth.uid(); item purama_ai.gmail_inbox_items%rowtype; deferred_at timestamptz;
BEGIN
  IF owner_id IS NULL OR p_resolution IS NULL OR p_resolution NOT IN ('observed','closed_without_retry') OR p_reference IS NULL
    OR length(btrim(p_reference)) NOT BETWEEN 1 AND 256 OR octet_length(p_reference)>1024 OR p_reference ~ '[[:cntrl:]]'
    THEN RETURN jsonb_build_object('status','blocked'); END IF;
  SELECT * INTO item FROM purama_ai.gmail_inbox_items WHERE id=p_item_id AND user_id=owner_id FOR UPDATE;
  IF item.id IS NULL OR item.mailbox IS DISTINCT FROM lower(btrim(p_expected_mailbox)) THEN RETURN jsonb_build_object('status','blocked'); END IF;
  IF item.state=p_resolution AND item.resolution_reference=btrim(p_reference) THEN RETURN jsonb_build_object('status',item.state,'item_id',item.id); END IF;
  IF item.state='done' AND item.reference LIKE 'approval:%' THEN
    SELECT purama_ai.gmail_inbox_approval_review_at(a.status,a.claimed_at,a.resolved_at,a.created_at) INTO deferred_at
      FROM purama_ai.karta_pending_actions a WHERE a.run_id=item.run_id AND a.user_id=owner_id AND a.agent_type=item.agent_type
        AND item.reference='approval:'||a.id::text FOR SHARE;
  END IF;
  IF NOT (item.state IN ('review','followup') OR deferred_at IS NOT NULL OR (item.state='armed' AND item.claimed_until<=clock_timestamp())) THEN
    RETURN jsonb_build_object('status','blocked'); END IF;
  UPDATE purama_ai.gmail_inbox_items SET state=p_resolution,resolution_reference=btrim(p_reference),review_at=clock_timestamp(),claimed_until=NULL WHERE id=item.id;
  RETURN jsonb_build_object('status',p_resolution,'item_id',item.id);
END $$;

REVOKE ALL ON FUNCTION purama_ai.gmail_inbox_policy_change(),purama_ai.gmail_inbox_config_stamp(),purama_ai.gmail_inbox_approval_review_at(text,timestamptz,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION
  purama_ai.gmail_inbox_capture(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb,text,text,boolean),
  purama_ai.gmail_inbox_approval_binding(uuid,uuid,uuid),
  purama_ai.gmail_inbox_claim(uuid,uuid,uuid,text,uuid),
  purama_ai.gmail_inbox_begin(uuid,uuid,uuid,uuid,text[]),
  purama_ai.gmail_inbox_finish(uuid,uuid,uuid,text,text),
  purama_ai.gmail_inbox_reviews(uuid),
  purama_ai.gmail_inbox_resolve(uuid,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
  purama_ai.gmail_inbox_capture(uuid,uuid,timestamptz,timestamptz,timestamptz,jsonb,text,text,boolean),
  purama_ai.gmail_inbox_approval_binding(uuid,uuid,uuid),
  purama_ai.gmail_inbox_claim(uuid,uuid,uuid,text,uuid),
  purama_ai.gmail_inbox_begin(uuid,uuid,uuid,uuid,text[]),
  purama_ai.gmail_inbox_finish(uuid,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION purama_ai.gmail_inbox_reviews(uuid), purama_ai.gmail_inbox_resolve(uuid,text,text,text) TO authenticated;
COMMIT;

-- IAO routines extend KARTA and the existing notification centre.
-- Requires the application's purama_ai.notifications / notification_preferences
-- and KARTA 002. No provider call, secret, phone number or recording is stored.
BEGIN;

CREATE OR REPLACE FUNCTION purama_ai.iao_valid_routine_timestamp(value text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
BEGIN
  IF value IS NULL OR value !~ '^([12][0-9]{3})-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$'
    OR left(value,4)::int NOT BETWEEN 1970 AND 2200
    OR (right(value,6) ~ '^[+-]14:' AND right(value,2) <> '00') THEN RETURN false; END IF;
  RETURN value::timestamptz IS NOT NULL;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_valid_routine_config(value jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE sched jsonb; quiet jsonb; item jsonb; kind text; n integer;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' OR
    (SELECT count(*) FROM jsonb_object_keys(value)) <> 13 OR
    value - ARRAY['name','instruction','enabled','schedule','channels','deliveryMode','agentTypes','length','quietHours','pausedUntil','onlyIfNew','maxCallMinutes','monthlyCallMinutes'] <> '{}'::jsonb
    THEN RETURN false; END IF;
  IF jsonb_typeof(value->'name') IS DISTINCT FROM 'string' OR char_length(btrim(value->>'name')) NOT BETWEEN 1 AND 100
    OR value->>'name' ~ '[[:cntrl:]]'
    OR jsonb_typeof(value->'instruction') IS DISTINCT FROM 'string' OR char_length(btrim(value->>'instruction')) NOT BETWEEN 1 AND 4000
    OR value->>'instruction' ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
    OR jsonb_typeof(value->'enabled') IS DISTINCT FROM 'boolean' OR jsonb_typeof(value->'onlyIfNew') IS DISTINCT FROM 'boolean'
    OR value->>'deliveryMode' NOT IN ('parallel','fallback') OR value->>'length' NOT IN ('express','standard','detailed')
    OR jsonb_typeof(value->'deliveryMode') IS DISTINCT FROM 'string' OR jsonb_typeof(value->'length') IS DISTINCT FROM 'string'
    THEN RETURN false; END IF;
  IF jsonb_typeof(value->'channels') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'channels') NOT BETWEEN 1 AND 4
    OR jsonb_typeof(value->'agentTypes') IS DISTINCT FROM 'array' OR jsonb_array_length(value->'agentTypes') > 32 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(value->'channels') entry WHERE jsonb_typeof(entry) <> 'string'
    OR entry #>> '{}' NOT IN ('call','in_app','push','email'))
    OR (SELECT count(DISTINCT entry) FROM jsonb_array_elements(value->'channels') entry) <> jsonb_array_length(value->'channels') THEN RETURN false; END IF;
  IF (SELECT count(DISTINCT entry) FROM jsonb_array_elements(value->'agentTypes') entry) <> jsonb_array_length(value->'agentTypes') THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value->'agentTypes') LOOP
    IF jsonb_typeof(item) <> 'string' OR (item #>> '{}' NOT IN ('email','compta','legal','partner','repondeur-intelligent','campagnes-par-courriel',
      'pro-de-la-sensibilisation-au-froid','newsletter-genie','facture-pro','rapports-financiers','chasseur-de-paiements','crm-intelligent',
      'machine-de-suivi','maitre-des-publicites','planificateur-d-appels','reservation-intelligente')
      AND item #>> '{}' !~* '^custom:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(value->'maxCallMinutes') IS DISTINCT FROM 'number' OR value->>'maxCallMinutes' !~ '^[0-9]+$'
    OR (value->>'maxCallMinutes')::numeric NOT BETWEEN 1 AND 10
    OR jsonb_typeof(value->'monthlyCallMinutes') IS DISTINCT FROM 'number' OR value->>'monthlyCallMinutes' !~ '^[0-9]+$'
    OR (value->>'monthlyCallMinutes')::numeric NOT BETWEEN 0 AND 3000 THEN RETURN false; END IF;
  IF value->'channels' ? 'call' AND (value->>'monthlyCallMinutes')::int < (value->>'maxCallMinutes')::int THEN RETURN false; END IF;
  IF value->'pausedUntil' IS DISTINCT FROM 'null'::jsonb AND (jsonb_typeof(value->'pausedUntil') IS DISTINCT FROM 'string'
    OR NOT purama_ai.iao_valid_routine_timestamp(value->>'pausedUntil')) THEN RETURN false; END IF;
  quiet := value->'quietHours';
  IF quiet IS DISTINCT FROM 'null'::jsonb THEN
    IF jsonb_typeof(quiet) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(quiet)) <> 2
      OR quiet - ARRAY['start','end'] <> '{}'::jsonb OR jsonb_typeof(quiet->'start') IS DISTINCT FROM 'string'
      OR jsonb_typeof(quiet->'end') IS DISTINCT FROM 'string'
      OR quiet->>'start' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR quiet->>'end' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      OR quiet->>'start' = quiet->>'end' THEN RETURN false; END IF;
  END IF;
  sched := value->'schedule'; kind := sched->>'kind';
  IF jsonb_typeof(sched) IS DISTINCT FROM 'object' OR kind IS NULL OR kind NOT IN ('daily','weekly','once','event')
    OR jsonb_typeof(sched->'timezone') IS DISTINCT FROM 'string' OR char_length(sched->>'timezone') > 100
    OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name = sched->>'timezone') THEN RETURN false; END IF;
  IF kind IN ('daily','weekly') THEN
    n := CASE WHEN kind='daily' THEN 3 ELSE 4 END;
    IF (SELECT count(*) FROM jsonb_object_keys(sched)) <> n
      OR sched - (CASE WHEN kind='daily' THEN ARRAY['kind','time','timezone'] ELSE ARRAY['kind','time','timezone','days'] END) <> '{}'::jsonb
      OR jsonb_typeof(sched->'time') IS DISTINCT FROM 'string' OR sched->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN false; END IF;
    IF kind='weekly' THEN
      IF jsonb_typeof(sched->'days') IS DISTINCT FROM 'array' OR jsonb_array_length(sched->'days') NOT BETWEEN 1 AND 7
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(sched->'days') day WHERE jsonb_typeof(day) <> 'number' OR day::text !~ '^[0-6]$')
        OR (SELECT count(DISTINCT day) FROM jsonb_array_elements(sched->'days') day) <> jsonb_array_length(sched->'days') THEN RETURN false; END IF;
    END IF;
  ELSIF kind='once' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(sched)) <> 3 OR sched - ARRAY['kind','at','timezone'] <> '{}'::jsonb
      OR jsonb_typeof(sched->'at') IS DISTINCT FROM 'string' OR NOT purama_ai.iao_valid_routine_timestamp(sched->>'at') THEN RETURN false; END IF;
  ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(sched)) <> 3 OR sched - ARRAY['kind','event','timezone'] <> '{}'::jsonb
      OR jsonb_typeof(sched->'event') IS DISTINCT FROM 'string' OR sched->>'event' NOT IN ('completed','blocked','decision') THEN RETURN false; END IF;
  END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$$;

CREATE TABLE IF NOT EXISTS purama_ai.iao_routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  config jsonb NOT NULL CHECK (purama_ai.iao_valid_routine_config(config)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_occurrence_at timestamptz,
  UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS iao_routines_owner ON purama_ai.iao_routines(user_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS purama_ai.iao_routine_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  routine_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision > 0),
  slot text NOT NULL CHECK(char_length(slot) BETWEEN 1 AND 200 AND slot !~ '[[:cntrl:]]'),
  scheduled_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK(expires_at > scheduled_at),
  report jsonb NOT NULL CHECK(jsonb_typeof(report)='object' AND octet_length(report::text) <= 65536),
  status text NOT NULL DEFAULT 'processing' CHECK(status IN ('pending','processing','completed','partial','failed','cancelled','unknown','skipped')),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(routine_id,user_id) REFERENCES purama_ai.iao_routines(id,user_id) ON DELETE CASCADE,
  UNIQUE(routine_id,slot), UNIQUE(id,user_id)
);
CREATE INDEX IF NOT EXISTS iao_routine_occurrences_owner ON purama_ai.iao_routine_occurrences(user_id,scheduled_at DESC);
CREATE INDEX IF NOT EXISTS iao_routine_occurrences_pending ON purama_ai.iao_routine_occurrences(status,lease_until);
CREATE TABLE IF NOT EXISTS purama_ai.iao_routine_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  channel text NOT NULL CHECK(channel IN ('call','in_app','push','email')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','completed','failed','unknown','skipped')),
  provider_id text,
  details jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(details)='object' AND octet_length(details::text) <= 16384),
  started_at timestamptz,
  lease_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(occurrence_id,user_id) REFERENCES purama_ai.iao_routine_occurrences(id,user_id) ON DELETE CASCADE,
  UNIQUE(occurrence_id,channel)
);
CREATE INDEX IF NOT EXISTS iao_routine_deliveries_budget ON purama_ai.iao_routine_deliveries(user_id,started_at) WHERE channel='call';
CREATE UNIQUE INDEX IF NOT EXISTS iao_routine_deliveries_call_provider ON purama_ai.iao_routine_deliveries(provider_id) WHERE channel='call' AND provider_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS purama_ai.iao_routine_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  occurrence_id uuid NOT NULL,
  request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 8 AND 128 AND request_key ~ '^[A-Za-z0-9._~-]+$'),
  instruction text NOT NULL CHECK(char_length(btrim(instruction)) BETWEEN 1 AND 4000),
  status text NOT NULL DEFAULT 'pending_confirmation' CHECK(status IN ('pending_confirmation','submitted','cancelled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(occurrence_id,user_id) REFERENCES purama_ai.iao_routine_occurrences(id,user_id) ON DELETE CASCADE,
  UNIQUE(occurrence_id,request_key)
);

ALTER TABLE purama_ai.iao_routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.iao_routine_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.iao_routine_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE purama_ai.iao_routine_commands ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iao_routines_read_owner ON purama_ai.iao_routines;
CREATE POLICY iao_routines_read_owner ON purama_ai.iao_routines FOR SELECT TO authenticated USING(user_id=auth.uid());
DROP POLICY IF EXISTS iao_occurrences_read_owner ON purama_ai.iao_routine_occurrences;
CREATE POLICY iao_occurrences_read_owner ON purama_ai.iao_routine_occurrences FOR SELECT TO authenticated USING(user_id=auth.uid());
DROP POLICY IF EXISTS iao_deliveries_read_owner ON purama_ai.iao_routine_deliveries;
CREATE POLICY iao_deliveries_read_owner ON purama_ai.iao_routine_deliveries FOR SELECT TO authenticated USING(user_id=auth.uid());
DROP POLICY IF EXISTS iao_commands_read_owner ON purama_ai.iao_routine_commands;
CREATE POLICY iao_commands_read_owner ON purama_ai.iao_routine_commands FOR SELECT TO authenticated USING(user_id=auth.uid());
REVOKE ALL ON purama_ai.iao_routines,purama_ai.iao_routine_occurrences,purama_ai.iao_routine_deliveries,purama_ai.iao_routine_commands FROM PUBLIC,anon,authenticated;
GRANT SELECT ON purama_ai.iao_routines,purama_ai.iao_routine_occurrences,purama_ai.iao_routine_deliveries,purama_ai.iao_routine_commands TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON purama_ai.iao_routines,purama_ai.iao_routine_occurrences,purama_ai.iao_routine_deliveries,purama_ai.iao_routine_commands TO service_role;

-- Private dispatch admission. Missing global authority fails closed; absent
-- preference row retains the established defaults, an explicit false wins.
CREATE OR REPLACE FUNCTION purama_ai.iao_routine_block_reason(p_user_id uuid,p_config jsonb,p_channel text,p_at timestamptz)
RETURNS text LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE local_time text; quiet jsonb; prefs record; preference text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM purama_ai.karta_global_state WHERE id='global' AND kill_switch=false) THEN RETURN 'global_stop'; END IF;
  IF p_config->>'enabled' IS DISTINCT FROM 'true' THEN RETURN 'disabled'; END IF;
  IF p_config->'pausedUntil' <> 'null'::jsonb AND (p_config->>'pausedUntil')::timestamptz > p_at THEN RETURN 'paused'; END IF;
  quiet := p_config->'quietHours';
  IF quiet <> 'null'::jsonb THEN
    local_time := to_char(p_at AT TIME ZONE (p_config->'schedule'->>'timezone'),'HH24:MI');
    IF ((quiet->>'start') < (quiet->>'end') AND local_time >= quiet->>'start' AND local_time < quiet->>'end')
      OR ((quiet->>'start') > (quiet->>'end') AND (local_time >= quiet->>'start' OR local_time < quiet->>'end')) THEN RETURN 'quiet_hours'; END IF;
  END IF;
  SELECT * INTO prefs FROM purama_ai.notification_preferences WHERE user_id=p_user_id;
  IF FOUND THEN
    preference := CASE p_config->'schedule'->>'event' WHEN 'completed' THEN 'task_completed_enabled'
      WHEN 'decision' THEN 'question_enabled' WHEN 'blocked' THEN 'alert_enabled' ELSE 'daily_report_enabled' END;
    IF to_jsonb(prefs)->>preference = 'false' THEN RETURN 'notification_preference'; END IF;
    IF p_channel='email' AND prefs.email_enabled IS FALSE THEN RETURN 'email_preference'; END IF;
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_save_routine(p_user_id uuid,p_routine_id uuid,p_expected_revision integer,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE current_row purama_ai.iao_routines%ROWTYPE;
BEGIN
  IF p_user_id IS NULL OR p_routine_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
    OR NOT purama_ai.iao_valid_routine_config(p_config) THEN RAISE EXCEPTION USING ERRCODE='PRT01', MESSAGE='Invalid routine'; END IF;
  -- Serialize creation/count and mutations for this owner, including lost replies.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,39001));
  SELECT * INTO current_row FROM purama_ai.iao_routines WHERE id=p_routine_id FOR UPDATE;
  IF FOUND THEN
    IF current_row.user_id <> p_user_id THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Routine conflict'; END IF;
    IF p_expected_revision=0 AND current_row.revision=1 AND current_row.config=p_config THEN RETURN to_jsonb(current_row); END IF;
    IF current_row.revision<>p_expected_revision THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Routine revision conflict'; END IF;
    IF current_row.config=p_config THEN RETURN to_jsonb(current_row); END IF;
    UPDATE purama_ai.iao_routines SET config=p_config,revision=revision+1,updated_at=clock_timestamp()
      WHERE id=p_routine_id AND user_id=p_user_id RETURNING * INTO current_row;
  ELSE
    IF p_expected_revision<>0 THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Routine revision conflict'; END IF;
    IF (SELECT count(*) FROM purama_ai.iao_routines WHERE user_id=p_user_id)>=100 THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Routine limit reached'; END IF;
    INSERT INTO purama_ai.iao_routines(id,user_id,config) VALUES(p_routine_id,p_user_id,p_config) RETURNING * INTO current_row;
  END IF;
  RETURN to_jsonb(current_row);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_pause_all_routines(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE changed integer;
BEGIN
  IF p_user_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid owner'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,39001));
  UPDATE purama_ai.iao_routines SET config=jsonb_set(config,'{enabled}','false'),revision=revision+1,updated_at=clock_timestamp()
    WHERE user_id=p_user_id AND config->>'enabled'='true';
  GET DIAGNOSTICS changed=ROW_COUNT;
  RETURN jsonb_build_object('updatedCount',changed);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_claim_routine_occurrence(p_user_id uuid,p_routine_id uuid,p_revision integer,p_slot text,
  p_scheduled_at timestamptz,p_expires_at timestamptz,p_report jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE routine purama_ai.iao_routines%ROWTYPE; occurrence purama_ai.iao_routine_occurrences%ROWTYPE; reason text; ts timestamptz := clock_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_routine_id IS NULL OR p_revision IS NULL OR p_slot IS NULL OR char_length(p_slot) NOT BETWEEN 1 AND 200 OR p_slot ~ '[[:cntrl:]]'
    OR p_scheduled_at IS NULL OR p_expires_at IS NULL OR p_expires_at<=p_scheduled_at OR p_expires_at>p_scheduled_at+interval '24 hours'
    OR p_scheduled_at>ts+interval '1 minute' OR jsonb_typeof(p_report) IS DISTINCT FROM 'object' OR octet_length(p_report::text)>65536
    THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid occurrence'; END IF;
  SELECT * INTO routine FROM purama_ai.iao_routines WHERE id=p_routine_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false,'reason','not_found','occurrence',null); END IF;
  ts:=clock_timestamp();
  IF routine.revision<>p_revision THEN RETURN jsonb_build_object('claimed',false,'reason','stale_revision','occurrence',null); END IF;
  reason:=purama_ai.iao_routine_block_reason(p_user_id,routine.config,NULL,ts);
  IF reason IS NOT NULL OR p_expires_at<=ts THEN RETURN jsonb_build_object('claimed',false,'reason',coalesce(reason,'expired'),'occurrence',null); END IF;
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE routine_id=p_routine_id AND slot=p_slot FOR UPDATE;
  IF FOUND THEN
    IF occurrence.user_id<>p_user_id OR occurrence.revision<>p_revision
      OR (p_slot NOT LIKE 'manual:%' AND occurrence.scheduled_at<>p_scheduled_at) THEN
      RETURN jsonb_build_object('claimed',false,'reason','occurrence_conflict','occurrence',to_jsonb(occurrence)); END IF;
    UPDATE purama_ai.iao_routine_deliveries SET status='unknown',lease_until=NULL,updated_at=ts,
      details=details||jsonb_build_object('reason','sending_lease_expired')
      WHERE occurrence_id=occurrence.id AND status='sending' AND lease_until<=ts;
    IF occurrence.status NOT IN ('pending','processing') OR occurrence.expires_at<=ts OR occurrence.lease_until>ts THEN
      RETURN jsonb_build_object('claimed',false,'reason','already_claimed','occurrence',to_jsonb(occurrence)); END IF;
    UPDATE purama_ai.iao_routine_occurrences SET status='processing',lease_until=ts+interval '90 seconds',updated_at=ts
      WHERE id=occurrence.id RETURNING * INTO occurrence;
  ELSE
    -- A new manual request key must not create a second live phone session
    -- while a previous click is queued, running or still unreconciled. The
    -- existing-slot branch above remains the way to recover a lost response.
    IF p_slot LIKE 'manual:%' AND EXISTS (
      SELECT 1 FROM purama_ai.iao_routine_occurrences prior
      JOIN purama_ai.iao_routine_deliveries item ON item.occurrence_id=prior.id
      WHERE prior.routine_id=p_routine_id AND prior.user_id=p_user_id
        AND prior.status IN ('pending','processing','unknown')
        AND (item.status IN ('sending','accepted','unknown') OR (item.status='pending' AND prior.expires_at>ts))
    ) THEN RETURN jsonb_build_object('claimed',false,'reason','active_occurrence','occurrence',null); END IF;
    INSERT INTO purama_ai.iao_routine_occurrences(user_id,routine_id,revision,slot,scheduled_at,expires_at,report,lease_until)
      VALUES(p_user_id,p_routine_id,p_revision,p_slot,p_scheduled_at,p_expires_at,p_report,ts+interval '90 seconds') RETURNING * INTO occurrence;
    INSERT INTO purama_ai.iao_routine_deliveries(user_id,occurrence_id,channel)
      SELECT p_user_id,occurrence.id,channel FROM jsonb_array_elements_text(routine.config->'channels') channel;
    UPDATE purama_ai.iao_routines SET last_occurrence_at=greatest(last_occurrence_at,p_scheduled_at) WHERE id=p_routine_id;
  END IF;
  RETURN jsonb_build_object('claimed',true,'occurrence',to_jsonb(occurrence));
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_begin_routine_delivery(p_user_id uuid,p_occurrence_id uuid,p_channel text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; routine purama_ai.iao_routines%ROWTYPE;
  delivery purama_ai.iao_routine_deliveries%ROWTYPE; reason text; ts timestamptz := clock_timestamp(); reserved integer; used integer; month_start timestamptz; month_end timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_occurrence_id IS NULL OR p_channel IS NULL OR p_channel NOT IN ('call','in_app','push','email') THEN
    RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid delivery'; END IF;
  -- All calls of one owner share one budget lock, even across different routines.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text,39001));
  SELECT * INTO routine FROM purama_ai.iao_routines WHERE user_id=p_user_id AND id=(SELECT routine_id FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('started',false,'reason','not_found','delivery',null); END IF;
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO delivery FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=p_occurrence_id AND user_id=p_user_id AND channel=p_channel FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('started',false,'reason','channel_not_selected','delivery',null); END IF;
  ts:=clock_timestamp();
  IF delivery.status='sending' AND delivery.lease_until<=ts THEN
    UPDATE purama_ai.iao_routine_deliveries SET status='unknown',lease_until=NULL,updated_at=ts,details=details||jsonb_build_object('reason','sending_lease_expired')
      WHERE id=delivery.id RETURNING * INTO delivery;
  END IF;
  IF delivery.status<>'pending' THEN RETURN jsonb_build_object('started',false,'reason','already_attempted','delivery',to_jsonb(delivery)); END IF;
  IF occurrence.scheduled_at>ts THEN RETURN jsonb_build_object('started',false,'reason','not_due','delivery',to_jsonb(delivery)); END IF;
  reason:=CASE WHEN occurrence.status NOT IN ('pending','processing')
      AND NOT (occurrence.status='unknown' AND routine.config->>'deliveryMode'='parallel') THEN 'occurrence_closed'
    WHEN occurrence.expires_at<=ts THEN 'expired' WHEN routine.revision<>occurrence.revision THEN 'stale_revision'
    WHEN NOT routine.config->'channels' ? p_channel THEN 'channel_not_selected'
    ELSE purama_ai.iao_routine_block_reason(p_user_id,routine.config,p_channel,ts) END;
  IF reason IS NULL AND p_channel='call' THEN
    reserved:=(routine.config->>'maxCallMinutes')::int;
    month_start:=date_trunc('month',ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    month_end:=(date_trunc('month',ts AT TIME ZONE 'UTC')+interval '1 month') AT TIME ZONE 'UTC';
    SELECT coalesce(sum((details->>'reservedMinutes')::int),0)::int INTO used FROM purama_ai.iao_routine_deliveries
      WHERE user_id=p_user_id AND channel='call' AND started_at>=month_start AND started_at<month_end;
    IF used+reserved>(routine.config->>'monthlyCallMinutes')::int THEN reason:='call_budget_exhausted'; END IF;
    IF reason IS NULL AND EXISTS(SELECT 1 FROM purama_ai.iao_routine_deliveries
      WHERE user_id=p_user_id AND channel='call' AND id<>delivery.id AND status IN ('sending','accepted','unknown')) THEN
      reason:='call_in_progress'; END IF;
  END IF;
  IF reason IS NOT NULL THEN
    UPDATE purama_ai.iao_routine_deliveries SET status='skipped',details=jsonb_build_object('reason',reason),updated_at=ts
      WHERE id=delivery.id RETURNING * INTO delivery;
    RETURN jsonb_build_object('started',false,'reason',reason,'delivery',to_jsonb(delivery));
  END IF;
  UPDATE purama_ai.iao_routine_deliveries SET status='sending',started_at=ts,lease_until=ts+interval '90 seconds',updated_at=ts,
    details=CASE WHEN p_channel='call' THEN jsonb_build_object('reservedMinutes',reserved,'budgetMonth',to_char(month_start AT TIME ZONE 'UTC','YYYY-MM'),'attempt',1)
      ELSE jsonb_build_object('attempt',1) END WHERE id=delivery.id RETURNING * INTO delivery;
  RETURN jsonb_build_object('started',true,'delivery',to_jsonb(delivery));
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_finish_routine_delivery(p_user_id uuid,p_occurrence_id uuid,p_channel text,p_status text,p_provider_id text,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; delivery purama_ai.iao_routine_deliveries%ROWTYPE; ts timestamptz:=clock_timestamp();
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('accepted','completed','failed','unknown','skipped') OR jsonb_typeof(p_details) IS DISTINCT FROM 'object'
    OR octet_length(p_details::text)>12000 OR (p_provider_id IS NOT NULL AND (char_length(btrim(p_provider_id)) NOT BETWEEN 1 AND 200 OR p_provider_id<>btrim(p_provider_id) OR p_provider_id ~ '[[:cntrl:]]'))
    OR (p_status IN ('accepted','completed') AND p_provider_id IS NULL) THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid delivery receipt'; END IF;
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('updated',false,'reason','not_found','delivery',null); END IF;
  SELECT * INTO delivery FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=p_occurrence_id AND user_id=p_user_id AND channel=p_channel FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('updated',false,'reason','not_found','delivery',null); END IF;
  ts:=clock_timestamp();
  -- Cancellation stops local work, but an already transmitted call still needs
  -- a verified terminal receipt to release the account-wide active-call lock.
  -- The trusted server verifies a newly bound provider ID before this RPC.
  IF occurrence.status='cancelled' AND (p_status NOT IN ('completed','failed') OR p_provider_id IS NULL) THEN
    RETURN jsonb_build_object('updated',false,'reason','occurrence_cancelled','delivery',to_jsonb(delivery)); END IF;
  IF delivery.provider_id IS NOT NULL AND p_provider_id IS DISTINCT FROM delivery.provider_id THEN
    RETURN jsonb_build_object('updated',false,'reason','receipt_conflict','delivery',to_jsonb(delivery)); END IF;
  IF delivery.status IN ('completed','failed','skipped') OR delivery.status='pending'
    OR (delivery.status='accepted' AND p_status IN ('unknown','skipped'))
    OR (delivery.status='unknown' AND p_status IN ('accepted','completed','failed') AND p_provider_id IS NULL) THEN
    RETURN jsonb_build_object('updated',false,'reason','transition_refused','delivery',to_jsonb(delivery)); END IF;
  UPDATE purama_ai.iao_routine_deliveries SET status=p_status,provider_id=coalesce(provider_id,p_provider_id),lease_until=NULL,updated_at=ts,
    details=details||(p_details-ARRAY['reservedMinutes','budgetMonth','attempt']) WHERE id=delivery.id RETURNING * INTO delivery;
  RETURN jsonb_build_object('updated',true,'delivery',to_jsonb(delivery));
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_cancel_routine_occurrence(p_user_id uuid,p_occurrence_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; ts timestamptz:=clock_timestamp();
BEGIN
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('cancelled',false); END IF;
  ts:=clock_timestamp();
  UPDATE purama_ai.iao_routine_occurrences SET status='cancelled',lease_until=NULL,updated_at=ts WHERE id=p_occurrence_id;
  UPDATE purama_ai.iao_routine_deliveries SET status=CASE WHEN status='pending' THEN 'skipped' ELSE 'unknown' END,
    lease_until=NULL,details=details||jsonb_build_object('reason','occurrence_cancelled'),updated_at=ts
    WHERE occurrence_id=p_occurrence_id AND status IN ('pending','sending');
  UPDATE purama_ai.iao_routine_commands SET status='cancelled',updated_at=ts WHERE occurrence_id=p_occurrence_id AND status='pending_confirmation';
  RETURN jsonb_build_object('cancelled',true,'externalCancellationConfirmed',false);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_record_routine_command(p_user_id uuid,p_occurrence_id uuid,p_request_key text,p_instruction text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; command purama_ai.iao_routine_commands%ROWTYPE;
  routine purama_ai.iao_routines%ROWTYPE; reason text;
BEGIN
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 8 AND 128 OR p_request_key !~ '^[A-Za-z0-9._~-]+$'
    OR p_instruction IS NULL OR char_length(btrim(p_instruction)) NOT BETWEEN 1 AND 4000
    OR p_instruction ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid command'; END IF;
  SELECT * INTO routine FROM purama_ai.iao_routines WHERE user_id=p_user_id AND id=(SELECT routine_id FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Occurrence unavailable'; END IF;
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR occurrence.status='cancelled' THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Occurrence unavailable'; END IF;
  SELECT * INTO command FROM purama_ai.iao_routine_commands WHERE occurrence_id=p_occurrence_id AND request_key=p_request_key;
  IF FOUND THEN
    IF command.user_id<>p_user_id OR command.instruction<>p_instruction THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Command conflict'; END IF;
    RETURN to_jsonb(command);
  END IF;
  reason:=CASE WHEN routine.revision<>occurrence.revision THEN 'stale_revision'
    ELSE purama_ai.iao_routine_block_reason(p_user_id,routine.config,'call',clock_timestamp()) END;
  IF reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM purama_ai.iao_routine_deliveries
      WHERE occurrence_id=p_occurrence_id AND user_id=p_user_id AND channel='call' AND status='accepted' AND provider_id IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Phone command unavailable'; END IF;
  IF (SELECT count(*) FROM purama_ai.iao_routine_commands WHERE occurrence_id=p_occurrence_id)>=100 THEN
    RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Command limit reached'; END IF;
  INSERT INTO purama_ai.iao_routine_commands(user_id,occurrence_id,request_key,instruction)
    VALUES(p_user_id,p_occurrence_id,p_request_key,p_instruction) RETURNING * INTO command;
  RETURN to_jsonb(command);
END;
$$;

CREATE OR REPLACE FUNCTION purama_ai.iao_record_routine_message(p_user_id uuid,p_occurrence_id uuid,p_title text,p_message text,p_action_url text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; delivery purama_ai.iao_routine_deliveries%ROWTYPE; routine purama_ai.iao_routines%ROWTYPE;
  existing purama_ai.notifications%ROWTYPE; reason text; ts timestamptz:=clock_timestamp();
BEGIN
  IF p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 300 OR p_title ~ '[[:cntrl:]]'
    OR p_message IS NULL OR char_length(btrim(p_message)) NOT BETWEEN 1 AND 5000
    OR (p_action_url IS NOT NULL AND (char_length(p_action_url)>2048 OR p_action_url !~ '^/($|[^/\\])' OR p_action_url ~ '[[:cntrl:]\\]' OR p_action_url ~* '%(2f|5c|00|0a|0d)'))
    THEN RAISE EXCEPTION USING ERRCODE='PRT01',MESSAGE='Invalid routine message'; END IF;
  SELECT * INTO routine FROM purama_ai.iao_routines WHERE user_id=p_user_id AND id=(SELECT routine_id FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id) FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Occurrence unavailable'; END IF;
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  SELECT * INTO delivery FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=p_occurrence_id AND user_id=p_user_id AND channel='in_app' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Message delivery not selected'; END IF;
  SELECT * INTO existing FROM purama_ai.notifications WHERE id=p_occurrence_id;
  IF FOUND THEN
    IF existing.user_id<>p_user_id OR existing.title<>p_title OR existing.message<>p_message OR existing.action_url IS DISTINCT FROM p_action_url
      OR delivery.status<>'completed' OR delivery.provider_id IS DISTINCT FROM p_occurrence_id::text THEN
      RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Message receipt conflict'; END IF;
    RETURN jsonb_build_object('ok',true,'notification_id',existing.id);
  END IF;
  ts:=clock_timestamp();
  reason:=CASE WHEN occurrence.status='cancelled' THEN 'cancelled' WHEN occurrence.expires_at<=ts THEN 'expired'
    WHEN routine.revision<>occurrence.revision THEN 'stale_revision' ELSE purama_ai.iao_routine_block_reason(p_user_id,routine.config,'in_app',ts) END;
  IF reason IS NOT NULL OR delivery.status<>'sending' THEN RETURN jsonb_build_object('ok',false,'reason',coalesce(reason,'delivery_not_started')); END IF;
  INSERT INTO purama_ai.notifications(id,user_id,agent_slug,type,title,message,action_url)
    VALUES(p_occurrence_id,p_user_id,NULL,'daily_report',p_title,p_message,p_action_url) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO existing FROM purama_ai.notifications WHERE id=p_occurrence_id;
  IF NOT FOUND OR existing.user_id<>p_user_id OR existing.title<>p_title OR existing.message<>p_message OR existing.action_url IS DISTINCT FROM p_action_url THEN
    RAISE EXCEPTION USING ERRCODE='PRT02',MESSAGE='Message receipt conflict'; END IF;
  UPDATE purama_ai.iao_routine_deliveries SET status='completed',provider_id=p_occurrence_id::text,lease_until=NULL,updated_at=ts WHERE id=delivery.id;
  RETURN jsonb_build_object('ok',true,'notification_id',p_occurrence_id);
END;
$$;

-- Derive the occurrence from locked, current receipts, never a worker's stale
-- read. A reconciled failed/non-human call can open its remaining fallback;
-- an unknown call cannot. completed is workflow completion, not proof of hearing.
CREATE OR REPLACE FUNCTION purama_ai.iao_refresh_routine_occurrence(p_user_id uuid,p_occurrence_id uuid,p_skip boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE occurrence purama_ai.iao_routine_occurrences%ROWTYPE; routine purama_ai.iao_routines%ROWTYPE;
  ts timestamptz; has_unknown boolean; waiting boolean; delivered boolean; failed boolean; next_status text;
BEGIN
  SELECT * INTO occurrence FROM purama_ai.iao_routine_occurrences WHERE id=p_occurrence_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF occurrence.status IN ('cancelled','completed') THEN RETURN to_jsonb(occurrence); END IF;
  ts:=clock_timestamp();
  SELECT * INTO routine FROM purama_ai.iao_routines WHERE id=occurrence.routine_id AND user_id=p_user_id;
  -- Every writer of delivery receipts first locks this occurrence, so these
  -- updates and the derived status share one serialized observation.
  UPDATE purama_ai.iao_routine_deliveries SET status='unknown',lease_until=NULL,updated_at=ts,
    details=details||jsonb_build_object('reason','sending_lease_expired')
    WHERE occurrence_id=p_occurrence_id AND status='sending' AND lease_until<=ts;
  IF p_skip OR occurrence.expires_at<=ts THEN
    UPDATE purama_ai.iao_routine_deliveries SET status='skipped',updated_at=ts,
      details=details||jsonb_build_object('reason',CASE WHEN p_skip THEN 'no_new_activity' ELSE 'expired' END)
      WHERE occurrence_id=p_occurrence_id AND status='pending';
  END IF;
  IF routine.config->>'deliveryMode'='fallback' AND EXISTS (
    SELECT 1 FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=p_occurrence_id
      AND ((channel<>'call' AND status IN ('accepted','completed')) OR (channel='call' AND status='completed' AND details->>'answeredBy'='human'))
  ) THEN
    UPDATE purama_ai.iao_routine_deliveries SET status='skipped',updated_at=ts,
      details=details||jsonb_build_object('reason','fallback_not_needed') WHERE occurrence_id=p_occurrence_id AND status='pending';
  END IF;
  SELECT coalesce(bool_or(status='unknown'),false),
    coalesce(bool_or(status IN ('pending','sending') OR (channel='call' AND status='accepted')),false),
    coalesce(bool_or((channel<>'call' AND status IN ('accepted','completed')) OR (channel='call' AND status='completed' AND details->>'answeredBy'='human')),false),
    coalesce(bool_or(status='failed' OR (channel='call' AND status='completed' AND details->>'answeredBy' IS DISTINCT FROM 'human')),false)
    INTO has_unknown,waiting,delivered,failed FROM purama_ai.iao_routine_deliveries WHERE occurrence_id=p_occurrence_id;
  next_status:=CASE WHEN has_unknown THEN 'unknown' WHEN waiting THEN 'processing'
    WHEN failed AND delivered THEN 'partial' WHEN failed THEN 'failed' WHEN delivered THEN 'completed' ELSE 'skipped' END;
  -- A successful fallback supersedes its primary channel's determined failure.
  IF routine.config->>'deliveryMode'='fallback' AND delivered AND NOT has_unknown AND NOT waiting THEN next_status:='completed'; END IF;
  UPDATE purama_ai.iao_routine_occurrences SET status=next_status,updated_at=ts,
    lease_until=CASE WHEN next_status='processing' THEN ts+interval '90 seconds' ELSE NULL END
    WHERE id=p_occurrence_id RETURNING * INTO occurrence;
  RETURN to_jsonb(occurrence);
END;
$$;

REVOKE ALL ON FUNCTION purama_ai.iao_valid_routine_timestamp(text),purama_ai.iao_valid_routine_config(jsonb),purama_ai.iao_routine_block_reason(uuid,jsonb,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.iao_valid_routine_timestamp(text),purama_ai.iao_valid_routine_config(jsonb),purama_ai.iao_routine_block_reason(uuid,jsonb,text,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION purama_ai.iao_save_routine(uuid,uuid,integer,jsonb),purama_ai.iao_pause_all_routines(uuid),
  purama_ai.iao_claim_routine_occurrence(uuid,uuid,integer,text,timestamptz,timestamptz,jsonb),
  purama_ai.iao_begin_routine_delivery(uuid,uuid,text),purama_ai.iao_finish_routine_delivery(uuid,uuid,text,text,text,jsonb),
  purama_ai.iao_cancel_routine_occurrence(uuid,uuid),purama_ai.iao_record_routine_command(uuid,uuid,text,text),
  purama_ai.iao_record_routine_message(uuid,uuid,text,text,text),purama_ai.iao_refresh_routine_occurrence(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION purama_ai.iao_save_routine(uuid,uuid,integer,jsonb),purama_ai.iao_pause_all_routines(uuid),
  purama_ai.iao_claim_routine_occurrence(uuid,uuid,integer,text,timestamptz,timestamptz,jsonb),
  purama_ai.iao_begin_routine_delivery(uuid,uuid,text),purama_ai.iao_finish_routine_delivery(uuid,uuid,text,text,text,jsonb),
  purama_ai.iao_cancel_routine_occurrence(uuid,uuid),purama_ai.iao_record_routine_command(uuid,uuid,text,text),
  purama_ai.iao_record_routine_message(uuid,uuid,text,text,text),purama_ai.iao_refresh_routine_occurrence(uuid,uuid,boolean) TO service_role;
COMMIT;

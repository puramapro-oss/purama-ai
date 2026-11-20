-- Missions : une commande authentifiée = une transaction, avec reprise réseau sûre.
-- Le propriétaire est organizer_id, jamais la première personne encore inscrite.
begin;

alter table purama_ai.missions_collectives
  add column version bigint not null default 1 check (version > 0);

create table purama_ai.entraide_mission_requests (
  actor_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  action text not null,
  mission_id uuid,
  payload jsonb not null,
  expected_version bigint,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (actor_id, request_id)
);
alter table purama_ai.entraide_mission_requests enable row level security;
revoke all on purama_ai.entraide_mission_requests from public, anon, authenticated;
grant all on purama_ai.entraide_mission_requests to service_role;

create function purama_ai.entraide_mission_mutate(
  p_request_id uuid,
  p_action text,
  p_mission_id uuid default null,
  p_payload jsonb default '{}'::jsonb,
  p_expected_version bigint default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_request purama_ai.entraide_mission_requests%rowtype;
  v_mission purama_ai.missions_collectives%rowtype;
  v_count bigint;
  v_member boolean;
  v_min integer;
  v_max integer;
  v_number numeric;
  v_response jsonb;
begin
  if v_actor is null then
    raise exception using errcode = 'P0001', message = 'auth_required';
  end if;
  if p_request_id is null or p_action is null
     or p_action not in ('create', 'join', 'leave', 'start', 'complete', 'cancel')
     or p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or (p_expected_version is not null and p_expected_version < 1) then
    raise exception using errcode = 'P0001', message = 'invalid_request';
  end if;
  if p_action = 'create' then
    if p_mission_id is not null or p_expected_version is not null
       or exists (select 1 from jsonb_object_keys(p_payload) as k(key)
                  where key not in ('title', 'description', 'min_participants', 'max_participants'))
       or jsonb_typeof(p_payload -> 'title') is distinct from 'string'
       or char_length(btrim(p_payload ->> 'title')) not between 1 and 200
       or jsonb_typeof(p_payload -> 'description') is distinct from 'string'
       or char_length(p_payload ->> 'description') > 2000
       or jsonb_typeof(p_payload -> 'min_participants') is distinct from 'number' then
      raise exception using errcode = 'P0001', message = 'invalid_request';
    end if;
    -- Vérifier le type avant le cast, indépendamment de l'ordre d'évaluation SQL.
    v_number := (p_payload ->> 'min_participants')::numeric;
    if v_number <> trunc(v_number) or v_number not between 2 and 2147483647 then
      raise exception using errcode = 'P0001', message = 'invalid_request';
    end if;
    v_min := v_number::integer;
    if p_payload ? 'max_participants' and p_payload -> 'max_participants' <> 'null'::jsonb then
      if jsonb_typeof(p_payload -> 'max_participants') <> 'number' then
        raise exception using errcode = 'P0001', message = 'invalid_request';
      end if;
      v_number := (p_payload ->> 'max_participants')::numeric;
      if v_number <> trunc(v_number) or v_number not between v_min and 2147483647 then
        raise exception using errcode = 'P0001', message = 'invalid_request';
      end if;
      v_max := v_number::integer;
    end if;
  elsif p_mission_id is null or p_payload <> '{}'::jsonb
        or (p_action in ('start', 'complete', 'cancel') and p_expected_version is null) then
    raise exception using errcode = 'P0001', message = 'invalid_request';
  end if;

  -- La contrainte unique attend la fin d'une requête concurrente de même identité.
  -- Toute exception annule aussi cette réservation : aucun résultat partiel n'est publié.
  insert into purama_ai.entraide_mission_requests
    (actor_id, request_id, action, mission_id, payload, expected_version)
  values (v_actor, p_request_id, p_action, p_mission_id, p_payload, p_expected_version)
  on conflict (actor_id, request_id) do nothing;
  select * into strict v_request from purama_ai.entraide_mission_requests
    where actor_id = v_actor and request_id = p_request_id for update;
  if v_request.action is distinct from p_action
     or v_request.mission_id is distinct from p_mission_id
     or v_request.payload is distinct from p_payload
     or v_request.expected_version is distinct from p_expected_version then
    raise exception using errcode = 'P0001', message = 'request_id_conflict';
  end if;
  if v_request.response is not null then
    return v_request.response || jsonb_build_object('replayed', true);
  end if;

  if p_action = 'create' then
    insert into purama_ai.missions_collectives
      (id, organizer_id, title, description, min_participants, max_participants)
    values (gen_random_uuid(), v_actor, btrim(p_payload ->> 'title'),
            p_payload ->> 'description', v_min, v_max)
    returning * into v_mission;
    insert into purama_ai.missions_collectives_participants (mission_id, user_id)
      values (v_mission.id, v_actor);
  else
    -- Toute commande prend ce verrou avant de consulter les inscriptions.
    select * into v_mission from purama_ai.missions_collectives
      where id = p_mission_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'mission_not_found';
    end if;
    if p_action in ('start', 'complete', 'cancel') and v_mission.organizer_id <> v_actor then
      raise exception using errcode = 'P0001', message = 'organizer_required';
    end if;
    if p_expected_version is not null and p_expected_version <> v_mission.version then
      raise exception using errcode = 'P0001', message = 'stale_mission';
    end if;
    select count(*), coalesce(bool_or(user_id = v_actor), false)
      into v_count, v_member
      from purama_ai.missions_collectives_participants where mission_id = v_mission.id;

    case p_action
      when 'join' then
        if v_mission.status not in ('ouverte', 'prete') then
          raise exception using errcode = 'P0001', message = 'mission_not_recruiting';
        end if;
        if v_member then
          raise exception using errcode = 'P0001', message = 'already_joined';
        end if;
        if v_mission.max_participants is not null and v_count >= v_mission.max_participants then
          raise exception using errcode = 'P0001', message = 'mission_full';
        end if;
        insert into purama_ai.missions_collectives_participants (mission_id, user_id)
          values (v_mission.id, v_actor);
        if v_count + 1 >= v_mission.min_participants then v_mission.status := 'prete'; end if;
      when 'leave' then
        if not v_member then
          raise exception using errcode = 'P0001', message = 'not_a_participant';
        end if;
        if v_mission.status in ('terminee', 'annulee') then
          raise exception using errcode = 'P0001', message = 'mission_closed';
        end if;
        delete from purama_ai.missions_collectives_participants
          where mission_id = v_mission.id and user_id = v_actor;
        if v_mission.status = 'prete' and v_count - 1 < v_mission.min_participants then
          v_mission.status := 'ouverte';
        end if;
      when 'start' then
        if v_mission.status <> 'prete' or v_count < v_mission.min_participants then
          raise exception using errcode = 'P0001', message = 'not_ready';
        end if;
        v_mission.status := 'en_cours';
      when 'complete' then
        if v_mission.status <> 'en_cours' then
          raise exception using errcode = 'P0001', message = 'not_in_progress';
        end if;
        v_mission.status := 'terminee';
      when 'cancel' then
        if v_mission.status in ('terminee', 'annulee') then
          raise exception using errcode = 'P0001', message = 'already_closed';
        end if;
        v_mission.status := 'annulee';
    end case;
    update purama_ai.missions_collectives
      set status = v_mission.status, version = version + 1, updated_at = now()
      where id = v_mission.id returning * into v_mission;
  end if;

  select jsonb_build_object(
    'mission', to_jsonb(v_mission) || jsonb_build_object(
      'missions_collectives_participants', coalesce(jsonb_agg(
        jsonb_build_object('user_id', p.user_id, 'joined_at', p.joined_at)
        order by p.joined_at, p.user_id), '[]'::jsonb)),
    'replayed', false)
  into v_response from purama_ai.missions_collectives_participants p
    where p.mission_id = v_mission.id;
  update purama_ai.entraide_mission_requests set response = v_response
    where actor_id = v_actor and request_id = p_request_id;
  return v_response;
end;
$$;

revoke all on function purama_ai.entraide_mission_mutate(uuid, text, uuid, jsonb, bigint)
  from public, anon, authenticated;
grant execute on function purama_ai.entraide_mission_mutate(uuid, text, uuid, jsonb, bigint)
  to authenticated;
-- L'accès aux tables reste en lecture seule pour les clients authentifiés.
revoke insert, update, delete on purama_ai.missions_collectives,
  purama_ai.missions_collectives_participants from anon, authenticated;

commit;

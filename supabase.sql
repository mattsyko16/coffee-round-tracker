-- Run in a NEW Supabase project. Do not run against the song app or the old coffee app.
-- All browser writes go through authenticated RPCs. Table data is never directly writable.
create extension if not exists pgcrypto;

create table public.coffee_settings (
  id boolean primary key default true check (id),
  code_hash text check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$')
);
insert into public.coffee_settings(id, code_hash) values (true, null);

create table public.coffee_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  is_admin boolean not null default false,
  joined_at timestamptz not null default now()
);

create table public.coffee_people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index coffee_people_name_unique on public.coffee_people(lower(btrim(name)));

create table public.coffee_rounds (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  round_date date not null,
  buyer_id uuid not null references public.coffee_people(id),
  attendee_ids uuid[] not null,
  cost_pence integer not null check (cost_pence between 0 and 1000000),
  kind text not null check (kind in ('round','historic','imported')),
  display_time text check (display_time is null or length(display_time) <= 40),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (cardinality(attendee_ids) between 1 and 50),
  check (buyer_id = any(attendee_ids))
);
create index coffee_rounds_date_idx on public.coffee_rounds(round_date desc, created_at desc);

create table public.coffee_revision (
  id boolean primary key default true check (id),
  version bigint not null default 0,
  changed_at timestamptz not null default now()
);
insert into public.coffee_revision(id) values (true);

alter table public.coffee_settings enable row level security;
alter table public.coffee_members enable row level security;
alter table public.coffee_people enable row level security;
alter table public.coffee_rounds enable row level security;
alter table public.coffee_revision enable row level security;
revoke all on public.coffee_settings, public.coffee_members, public.coffee_people,
  public.coffee_rounds, public.coffee_revision from public, anon, authenticated;
grant select on public.coffee_revision to authenticated;
grant select on public.coffee_members to authenticated;
create policy coffee_member_self_read on public.coffee_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy coffee_revision_member_read on public.coffee_revision
  for select to authenticated using (
    exists (select 1 from public.coffee_members m where m.user_id = (select auth.uid()))
  );

create schema if not exists private;

create function private.coffee_member_required(p_admin boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.coffee_members m
    where m.user_id = auth.uid() and (not p_admin or m.is_admin)
  ) then
    raise exception 'Coffee access denied' using errcode = '42501';
  end if;
end;
$$;

create function private.coffee_validate_attendees(p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 50
     or array_position(p_ids, null) is not null
     or (select count(distinct a.id) from unnest(p_ids) a(id)) <> cardinality(p_ids)
     or (select count(*) from public.coffee_people p where p.id = any(p_ids) and p.active) <> cardinality(p_ids)
  then
    raise exception 'Choose one or more different, active attendees' using errcode = '22023';
  end if;
end;
$$;

-- Allocates any odd pennies by UUID order so every round's shares add up exactly.
create function private.coffee_balances()
returns table(person_id uuid, spent_pence bigint, share_pence bigint,
              bought bigint, attended bigint, balance_pence bigint)
language sql security definer set search_path = '' as $$
  with allocated as (
    select a.person_id,
      (r.cost_pence / cardinality(r.attendee_ids))::bigint
      + case when row_number() over (partition by r.id order by a.person_id)
          <= (r.cost_pence % cardinality(r.attendee_ids)) then 1 else 0 end as share
    from public.coffee_rounds r
    cross join lateral unnest(r.attendee_ids) a(person_id)
  ), shares as (
    select person_id, sum(share)::bigint share_pence, count(*)::bigint attended
    from allocated group by person_id
  ), purchases as (
    select buyer_id, sum(cost_pence)::bigint spent_pence, count(*)::bigint bought
    from public.coffee_rounds group by buyer_id
  )
  select p.id, coalesce(b.spent_pence,0), coalesce(s.share_pence,0),
         coalesce(b.bought,0), coalesce(s.attended,0),
         coalesce(b.spent_pence,0) - coalesce(s.share_pence,0)
  from public.coffee_people p
  left join shares s on s.person_id = p.id
  left join purchases b on b.buyer_id = p.id;
$$;

create function private.coffee_pick_buyer(p_ids uuid[])
returns uuid language sql security definer set search_path = '' as $$
  select b.person_id from private.coffee_balances() b
  join public.coffee_people p on p.id = b.person_id
  where b.person_id = any(p_ids)
  order by b.balance_pence, b.spent_pence, b.bought, lower(p.name), p.id
  limit 1;
$$;

create function public.coffee_join(p_code text, p_name text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_hash text; v_admin boolean;
begin
  if auth.uid() is null or p_code is null or length(btrim(p_code)) not between 16 and 128
     or p_name is null or length(btrim(p_name)) not between 1 and 80 then
    return false;
  end if;
  select code_hash into v_hash from public.coffee_settings where id = true for update;
  if v_hash is null or encode(sha256(convert_to(btrim(p_code),'UTF8')),'hex') <> v_hash then
    return false;
  end if;
  select not exists(select 1 from public.coffee_members) into v_admin;
  insert into public.coffee_members(user_id, display_name, is_admin)
    values (auth.uid(), btrim(p_name), v_admin)
    on conflict (user_id) do update set display_name = excluded.display_name;
  return true;
end;
$$;

create function public.coffee_snapshot()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform private.coffee_member_required();
  select jsonb_build_object(
    'version', (select version from public.coffee_revision where id = true),
    'is_admin', (select is_admin from public.coffee_members where user_id = auth.uid()),
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at, p.id)
      from public.coffee_people p),'[]'::jsonb),
    'rounds', coalesce((select jsonb_agg(to_jsonb(r) order by r.round_date, r.created_at, r.id)
      from public.coffee_rounds r),'[]'::jsonb),
    'balances', coalesce((select jsonb_agg(to_jsonb(b))
      from private.coffee_balances() b),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create function public.coffee_preview(p_attendee_ids uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  perform private.coffee_member_required();
  perform private.coffee_validate_attendees(p_attendee_ids);
  return private.coffee_pick_buyer(p_attendee_ids);
end;
$$;

create function public.coffee_add_person(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.coffee_member_required();
  if p_name is null or length(btrim(p_name)) not between 1 and 80 then
    raise exception 'Name must be 1 to 80 characters' using errcode = '22023';
  end if;
  perform 1 from public.coffee_revision where id = true for update;
  insert into public.coffee_people(name) values (btrim(p_name)) returning id into v_id;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return v_id;
end;
$$;

create function public.coffee_archive_person(p_person_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.coffee_member_required();
  perform 1 from public.coffee_revision where id = true for update;
  if (select count(*) from public.coffee_people where active) <= 1 then
    raise exception 'Keep at least one active person' using errcode = '22023';
  end if;
  update public.coffee_people set active = false where id = p_person_id and active;
  if not found then raise exception 'Active person not found' using errcode = '22023'; end if;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
end;
$$;

create function public.coffee_record_round(
  p_request_id uuid, p_attendee_ids uuid[], p_cost_pence integer,
  p_round_date date default current_date, p_historic_buyer_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_round public.coffee_rounds%rowtype; v_buyer uuid; v_kind text;
begin
  perform private.coffee_member_required();
  if p_request_id is null or p_attendee_ids is null or p_cost_pence is null or p_round_date is null then
    raise exception 'Missing round data' using errcode = '22023';
  end if;
  perform 1 from public.coffee_revision where id = true for update;
  select * into v_round from public.coffee_rounds where request_id = p_request_id;
  if found then
    if v_round.attendee_ids is distinct from p_attendee_ids or v_round.cost_pence is distinct from p_cost_pence
       or v_round.round_date is distinct from p_round_date
       or v_round.kind is distinct from case when p_historic_buyer_id is null then 'round' else 'historic' end
       or (p_historic_buyer_id is not null and v_round.buyer_id is distinct from p_historic_buyer_id) then
      raise exception 'Request ID reused with different data' using errcode = '22023';
    end if;
    return jsonb_build_object('id',v_round.id,'buyer_id',v_round.buyer_id,'duplicate',true);
  end if;
  perform private.coffee_validate_attendees(p_attendee_ids);
  if p_cost_pence is null or p_cost_pence not between 1 and 1000000
     or p_round_date is null or p_round_date > current_date + 1 then
    raise exception 'Enter a valid cost and date' using errcode = '22023';
  end if;
  if p_historic_buyer_id is null then
    v_buyer := private.coffee_pick_buyer(p_attendee_ids);
    v_kind := 'round';
  else
    if not p_historic_buyer_id = any(p_attendee_ids) then
      raise exception 'Buyer must be attending' using errcode = '22023';
    end if;
    v_buyer := p_historic_buyer_id;
    v_kind := 'historic';
  end if;
  insert into public.coffee_rounds(request_id,round_date,buyer_id,attendee_ids,cost_pence,kind,created_by)
    values(p_request_id,p_round_date,v_buyer,p_attendee_ids,p_cost_pence,v_kind,auth.uid())
    returning * into v_round;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return jsonb_build_object('id',v_round.id,'buyer_id',v_buyer,'duplicate',false);
end;
$$;

create function public.coffee_delete_round(p_round_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.coffee_member_required();
  perform 1 from public.coffee_revision where id = true for update;
  delete from public.coffee_rounds where id = p_round_id;
  if not found then raise exception 'Round not found' using errcode = '22023'; end if;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
end;
$$;

-- One transaction. Admin only, and only into an empty board. Existing phone data is untouched.
create function public.coffee_import_legacy(p_people jsonb, p_rounds jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person jsonb; v_round jsonb; v_name text; v_id uuid;
        v_map jsonb := '{}'::jsonb; v_ids uuid[]; v_buyer uuid;
        v_count integer := 0; v_date date; v_cost integer; v_time text;
begin
  perform private.coffee_member_required(true);
  perform 1 from public.coffee_revision where id = true for update;
  if exists(select 1 from public.coffee_people) or exists(select 1 from public.coffee_rounds) then
    raise exception 'Import requires an empty board' using errcode = '22023';
  end if;
  if jsonb_typeof(p_people) is distinct from 'array' or jsonb_array_length(p_people) not between 1 and 50
     or jsonb_typeof(p_rounds) is distinct from 'array' or jsonb_array_length(p_rounds) > 5000 then
    raise exception 'Invalid backup size' using errcode = '22023';
  end if;
  for v_person in select value from jsonb_array_elements(p_people) loop
    if jsonb_typeof(v_person) <> 'object' or jsonb_typeof(v_person->'name') <> 'string'
       or jsonb_typeof(v_person->'active') <> 'boolean' then
      raise exception 'Invalid person' using errcode = '22023';
    end if;
    v_name := btrim(v_person->>'name');
    if length(v_name) not between 1 and 80 then raise exception 'Invalid name' using errcode = '22023'; end if;
    insert into public.coffee_people(name,active) values(v_name,(v_person->>'active')::boolean)
      returning id into v_id;
    v_map := v_map || jsonb_build_object(lower(v_name),v_id);
  end loop;
  if not exists(select 1 from public.coffee_people where active) then
    raise exception 'At least one person must be active' using errcode = '22023';
  end if;
  for v_round in select value from jsonb_array_elements(p_rounds) loop
    if jsonb_typeof(v_round) <> 'object' or jsonb_typeof(v_round->'attendees') <> 'array'
       or jsonb_array_length(v_round->'attendees') not between 1 and 50
       or (v_round->>'cost_pence') !~ '^[0-9]{1,7}$'
       or (v_round->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'Invalid round' using errcode = '22023';
    end if;
    v_cost := (v_round->>'cost_pence')::integer;
    if v_cost > 1000000 then raise exception 'Cost too large' using errcode = '22023'; end if;
    v_date := (v_round->>'date')::date;
    if v_date > current_date + 1 then raise exception 'Future date' using errcode = '22023'; end if;
    v_time := v_round->>'time';
    if length(v_time) > 40 then raise exception 'Invalid time label' using errcode = '22023'; end if;
    v_buyer := (v_map->>lower(btrim(v_round->>'buyer')))::uuid;
    if v_buyer is null then raise exception 'Unknown buyer' using errcode = '22023'; end if;
    select array_agg((v_map->>lower(btrim(a.value #>> '{}')))::uuid order by a.ordinality)
      into v_ids from jsonb_array_elements(v_round->'attendees') with ordinality a(value,ordinality);
    if array_position(v_ids,null) is not null or array_position(v_ids,v_buyer) is null
       or (select count(distinct a.id) from unnest(v_ids) a(id)) <> cardinality(v_ids) then
      raise exception 'Invalid attendees' using errcode = '22023';
    end if;
    insert into public.coffee_rounds(request_id,round_date,buyer_id,attendee_ids,cost_pence,kind,display_time,created_by)
      values(gen_random_uuid(),v_date,v_buyer,v_ids,v_cost,'imported',v_time,auth.uid());
    v_count := v_count + 1;
  end loop;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return jsonb_build_object('people',jsonb_array_length(p_people),'rounds',v_count);
end;
$$;

-- PostgreSQL grants EXECUTE on new functions to PUBLIC by default: remove it explicitly.
revoke all on function private.coffee_member_required(boolean), private.coffee_validate_attendees(uuid[]),
  private.coffee_balances(), private.coffee_pick_buyer(uuid[]) from public, anon, authenticated;
revoke all on function public.coffee_join(text,text), public.coffee_snapshot(),
  public.coffee_preview(uuid[]), public.coffee_add_person(text), public.coffee_archive_person(uuid),
  public.coffee_record_round(uuid,uuid[],integer,date,uuid), public.coffee_delete_round(uuid),
  public.coffee_import_legacy(jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.coffee_join(text,text), public.coffee_snapshot(),
  public.coffee_preview(uuid[]), public.coffee_add_person(text), public.coffee_archive_person(uuid),
  public.coffee_record_round(uuid,uuid[],integer,date,uuid), public.coffee_delete_round(uuid),
  public.coffee_import_legacy(jsonb,jsonb) to authenticated;

-- Only the revision marker is exposed to Realtime; its RLS policy gates events.
alter publication supabase_realtime add table public.coffee_revision;


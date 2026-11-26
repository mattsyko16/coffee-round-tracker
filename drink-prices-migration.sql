-- Add per-person drink prices without changing existing coffee rounds.
-- Existing rows keep drink_items = null and continue to split equally.

alter table public.coffee_rounds
  add column drink_items jsonb
  check (drink_items is null or jsonb_typeof(drink_items) = 'array');

create or replace function private.coffee_validate_drinks(
  p_attendee_ids uuid[], p_cost_pence integer, p_drinks jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_price bigint;
  v_sum bigint := 0;
begin
  if jsonb_typeof(p_drinks) is distinct from 'array'
     or jsonb_array_length(p_drinks) <> cardinality(p_attendee_ids) then
    raise exception 'Choose one drink and price for each attendee' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_drinks) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item->'person_id') is distinct from 'string'
       or coalesce(v_item->>'person_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_item->>'drink','') not in ('tea','americano','latte')
       or jsonb_typeof(v_item->'price_pence') is distinct from 'number'
       or coalesce(v_item->>'price_pence','') !~ '^[1-9][0-9]{0,6}$' then
      raise exception 'Invalid drink or price' using errcode = '22023';
    end if;
    v_id := (v_item->>'person_id')::uuid;
    v_price := (v_item->>'price_pence')::bigint;
    if v_price > 1000000 or not (v_id = any(p_attendee_ids)) or v_id = any(v_seen) then
      raise exception 'Drink does not match attendees' using errcode = '22023';
    end if;
    v_seen := array_append(v_seen, v_id);
    v_sum := v_sum + v_price;
  end loop;
  if v_sum <> p_cost_pence then
    raise exception 'Drink prices must add up to the total paid' using errcode = '22023';
  end if;
end;
$$;

create or replace function private.coffee_balances()
returns table(person_id uuid, spent_pence bigint, share_pence bigint,
              bought bigint, attended bigint, balance_pence bigint)
language sql security definer set search_path = '' as $$
  with equal_allocated as (
    select a.person_id,
      (r.cost_pence / cardinality(r.attendee_ids))::bigint
      + case when row_number() over (partition by r.id order by a.person_id)
          <= (r.cost_pence % cardinality(r.attendee_ids)) then 1 else 0 end as share
    from public.coffee_rounds r
    cross join lateral unnest(r.attendee_ids) a(person_id)
    where r.drink_items is null
  ), drink_allocated as (
    select (d.item->>'person_id')::uuid as person_id,
           (d.item->>'price_pence')::bigint as share
    from public.coffee_rounds r
    cross join lateral jsonb_array_elements(r.drink_items) d(item)
    where r.drink_items is not null
  ), allocated as (
    select person_id, share from equal_allocated
    union all
    select person_id, share from drink_allocated
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

create or replace function public.coffee_record_round_itemized(
  p_request_id uuid, p_attendee_ids uuid[], p_cost_pence integer,
  p_round_date date, p_historic_buyer_id uuid, p_drinks jsonb
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
    if v_round.attendee_ids <> p_attendee_ids or v_round.cost_pence <> p_cost_pence
       or v_round.round_date <> p_round_date or v_round.drink_items is distinct from p_drinks
       or (p_historic_buyer_id is null and v_round.kind <> 'round')
       or (p_historic_buyer_id is not null and
           (v_round.kind <> 'historic' or v_round.buyer_id <> p_historic_buyer_id)) then
      raise exception 'Request ID reused with different data' using errcode = '22023';
    end if;
    return jsonb_build_object('id',v_round.id,'buyer_id',v_round.buyer_id,'duplicate',true);
  end if;
  perform private.coffee_validate_attendees(p_attendee_ids);
  if p_cost_pence not between 1 and 1000000 or p_round_date > current_date + 1 then
    raise exception 'Enter a valid cost and date' using errcode = '22023';
  end if;
  perform private.coffee_validate_drinks(p_attendee_ids,p_cost_pence,p_drinks);
  if p_historic_buyer_id is null then
    v_buyer := private.coffee_pick_buyer(p_attendee_ids);
    v_kind := 'round';
  else
    if not (p_historic_buyer_id = any(p_attendee_ids)) then
      raise exception 'Buyer must be attending' using errcode = '22023';
    end if;
    v_buyer := p_historic_buyer_id;
    v_kind := 'historic';
  end if;
  insert into public.coffee_rounds(request_id,round_date,buyer_id,attendee_ids,cost_pence,kind,drink_items,created_by)
    values(p_request_id,p_round_date,v_buyer,p_attendee_ids,p_cost_pence,v_kind,p_drinks,auth.uid())
    returning * into v_round;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return jsonb_build_object('id',v_round.id,'buyer_id',v_buyer,'duplicate',false);
end;
$$;

create or replace function public.coffee_import_legacy(p_people jsonb, p_rounds jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person jsonb; v_round jsonb; v_name text; v_id uuid;
        v_map jsonb := '{}'::jsonb; v_ids uuid[]; v_buyer uuid;
        v_count integer := 0; v_date date; v_cost integer; v_time text;
        v_drink jsonb; v_drinks jsonb;
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
    v_drinks := null;
    if v_round ? 'drinks' then
      if jsonb_typeof(v_round->'drinks') is distinct from 'array' then
        raise exception 'Invalid drink list' using errcode = '22023';
      end if;
      v_drinks := '[]'::jsonb;
      for v_drink in select value from jsonb_array_elements(v_round->'drinks') loop
        v_id := (v_map->>lower(btrim(coalesce(v_drink->>'person',''))))::uuid;
        v_drinks := v_drinks || jsonb_build_array(jsonb_build_object(
          'person_id',v_id,'drink',v_drink->>'drink','price_pence',v_drink->'price_pence'
        ));
      end loop;
      perform private.coffee_validate_drinks(v_ids,v_cost,v_drinks);
    end if;
    insert into public.coffee_rounds(request_id,round_date,buyer_id,attendee_ids,cost_pence,kind,display_time,drink_items,created_by)
      values(gen_random_uuid(),v_date,v_buyer,v_ids,v_cost,'imported',v_time,v_drinks,auth.uid());
    v_count := v_count + 1;
  end loop;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return jsonb_build_object('people',jsonb_array_length(p_people),'rounds',v_count);
end;
$$;

revoke all on function private.coffee_validate_drinks(uuid[],integer,jsonb)
  from public, anon, authenticated;
revoke all on function public.coffee_record_round_itemized(uuid,uuid[],integer,date,uuid,jsonb)
  from public, anon, authenticated;
grant execute on function public.coffee_record_round_itemized(uuid,uuid[],integer,date,uuid,jsonb)
  to authenticated;


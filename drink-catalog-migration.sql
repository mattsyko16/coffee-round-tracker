-- Shared drink price list. Recorded rounds keep their own drink names and prices.
create table public.coffee_drinks (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 80 and name !~ '[[:cntrl:]]'),
  price_pence integer check (price_pence between 1 and 1000000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index coffee_drinks_name_unique on public.coffee_drinks(lower(btrim(name)));
insert into public.coffee_drinks(name) values ('Tea'), ('Americano'), ('Latte');
alter table public.coffee_drinks enable row level security;
revoke all on public.coffee_drinks from public, anon, authenticated;

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
       or coalesce(v_item->>'person_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or length(btrim(coalesce(v_item->>'drink',''))) not between 1 and 80
       or coalesce(v_item->>'drink','') ~ '[[:cntrl:]]'
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

create or replace function private.coffee_validate_catalog_drinks(p_drinks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_array_elements(p_drinks) d(item)
    where not exists (
      select 1 from public.coffee_drinks c
      where c.active and c.name = d.item->>'drink'
    )
  ) then
    raise exception 'Choose a drink from the current price list' using errcode = '22023';
  end if;
end;
$$;

create or replace function public.coffee_snapshot()
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
    'drinks', coalesce((select jsonb_agg(to_jsonb(d) order by lower(d.name), d.id)
      from public.coffee_drinks d),'[]'::jsonb),
    'balances', coalesce((select jsonb_agg(to_jsonb(b))
      from private.coffee_balances() b),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$$;

create or replace function public.coffee_add_drink(p_name text, p_price_pence integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_active boolean;
begin
  perform private.coffee_member_required();
  if p_name is null or length(btrim(p_name)) not between 1 and 80
     or p_name ~ '[[:cntrl:]]' or p_price_pence is null
     or p_price_pence not between 1 and 1000000 then
    raise exception 'Enter a valid drink name and price' using errcode = '22023';
  end if;
  perform 1 from public.coffee_revision where id = true for update;
  select id, active into v_id, v_active from public.coffee_drinks
    where lower(btrim(name)) = lower(btrim(p_name)) for update;
  if found then
    if v_active then raise exception 'Drink already exists' using errcode = '22023'; end if;
    update public.coffee_drinks set name = btrim(p_name), price_pence = p_price_pence, active = true
      where id = v_id;
  else
    insert into public.coffee_drinks(name,price_pence) values(btrim(p_name),p_price_pence)
      returning id into v_id;
  end if;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return v_id;
end;
$$;

create or replace function public.coffee_set_drink_price(
  p_drink_id uuid, p_price_pence integer, p_expected_price_pence integer
) returns void language plpgsql security definer set search_path = '' as $$
declare v_current integer;
begin
  perform private.coffee_member_required();
  if p_drink_id is null or p_price_pence is null or p_price_pence not between 1 and 1000000 then
    raise exception 'Enter a valid drink price' using errcode = '22023';
  end if;
  perform 1 from public.coffee_revision where id = true for update;
  select price_pence into v_current from public.coffee_drinks
    where id = p_drink_id and active for update;
  if not found then raise exception 'Drink not found' using errcode = '22023'; end if;
  if v_current is distinct from p_expected_price_pence then
    raise exception 'Drink price changed on another device; refresh and try again' using errcode = '40001';
  end if;
  if v_current is not distinct from p_price_pence then return; end if;
  update public.coffee_drinks set price_pence = p_price_pence where id = p_drink_id;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
end;
$$;

create or replace function public.coffee_archive_drink(p_drink_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.coffee_member_required();
  if p_drink_id is null then raise exception 'Choose a drink' using errcode = '22023'; end if;
  perform 1 from public.coffee_revision where id = true for update;
  update public.coffee_drinks set active = false where id = p_drink_id and active;
  if not found then raise exception 'Active drink not found' using errcode = '22023'; end if;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
end;
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
  perform private.coffee_validate_catalog_drinks(p_drinks);
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

create or replace function public.coffee_import_with_catalog(
  p_people jsonb, p_rounds jsonb, p_catalog jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_item jsonb; v_name text; v_price integer;
begin
  perform private.coffee_member_required(true);
  if jsonb_typeof(p_catalog) is distinct from 'array' or jsonb_array_length(p_catalog) > 100 then
    raise exception 'Invalid drink price list' using errcode = '22023';
  end if;
  -- The legacy import locks the revision row and rejects any nonempty board.
  v_result := public.coffee_import_legacy(p_people,p_rounds);
  delete from public.coffee_drinks;
  for v_item in select value from jsonb_array_elements(p_catalog) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item->'name') is distinct from 'string'
       or jsonb_typeof(v_item->'active') is distinct from 'boolean'
       or not (v_item ? 'price_pence') then
      raise exception 'Invalid drink price list' using errcode = '22023';
    end if;
    v_name := btrim(v_item->>'name');
    if length(v_name) not between 1 and 80 or v_name ~ '[[:cntrl:]]' then
      raise exception 'Invalid drink name' using errcode = '22023';
    end if;
    v_price := null;
    if v_item->'price_pence' <> 'null'::jsonb then
      if jsonb_typeof(v_item->'price_pence') is distinct from 'number'
         or coalesce(v_item->>'price_pence','') !~ '^[1-9][0-9]{0,6}$' then
        raise exception 'Invalid drink price' using errcode = '22023';
      end if;
      v_price := (v_item->>'price_pence')::integer;
      if v_price > 1000000 then raise exception 'Invalid drink price' using errcode = '22023'; end if;
    end if;
    insert into public.coffee_drinks(name,price_pence,active)
      values(v_name,v_price,(v_item->>'active')::boolean);
  end loop;
  update public.coffee_revision set version = version + 1, changed_at = now() where id = true;
  return v_result || jsonb_build_object('catalog',jsonb_array_length(p_catalog));
end;
$$;

revoke all on public.coffee_drinks from public, anon, authenticated;
revoke all on function private.coffee_validate_drinks(uuid[],integer,jsonb),
  private.coffee_validate_catalog_drinks(jsonb) from public, anon, authenticated;
revoke all on function public.coffee_add_drink(text,integer),
  public.coffee_set_drink_price(uuid,integer,integer),
  public.coffee_archive_drink(uuid),
  public.coffee_import_with_catalog(jsonb,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.coffee_add_drink(text,integer),
  public.coffee_set_drink_price(uuid,integer,integer),
  public.coffee_archive_drink(uuid),
  public.coffee_import_with_catalog(jsonb,jsonb,jsonb) to authenticated;


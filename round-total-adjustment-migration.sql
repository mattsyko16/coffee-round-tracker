-- Allow the receipt total to differ from individual drink prices. Allocate the
-- difference equally in whole pennies, with remaining pennies assigned in
-- person ID order. Existing rounds and stored drink prices are untouched.

create or replace function private.coffee_validate_drinks(
  p_attendee_ids uuid[], p_cost_pence integer, p_drinks jsonb
) returns void language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id uuid;
  v_seen uuid[] := '{}'::uuid[];
  v_price bigint;
  v_sum bigint := 0;
  v_difference bigint;
  v_each bigint;
  v_remainder bigint;
  v_min_share bigint;
begin
  if jsonb_typeof(p_drinks) is distinct from 'array'
     or jsonb_array_length(p_drinks) <> cardinality(p_attendee_ids) then
    raise exception 'Choose one drink and price for each attendee' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_drinks) loop
    if jsonb_typeof(v_item) is distinct from 'object'
       or jsonb_typeof(v_item->'person_id') is distinct from 'string'
       or coalesce(v_item->>'person_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
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
  v_difference := p_cost_pence::bigint - v_sum;
  v_each := floor(v_difference::numeric / cardinality(p_attendee_ids))::bigint;
  v_remainder := v_difference - v_each * cardinality(p_attendee_ids);
  select min(price + v_each + case when rank <= v_remainder then 1 else 0 end)
    into v_min_share
  from (
    select (item->>'price_pence')::bigint as price,
           row_number() over (order by (item->>'person_id')::uuid) as rank
    from jsonb_array_elements(p_drinks) as d(item)
  ) as ordered_drinks;
  if v_min_share < 0 then
    raise exception 'Discount would make a person''s share negative' using errcode = '22023';
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
  ), priced as (
    select r.id as round_id, r.cost_pence, cardinality(r.attendee_ids) as attendee_count,
           (d.item->>'person_id')::uuid as person_id,
           (d.item->>'price_pence')::bigint as price
    from public.coffee_rounds r
    cross join lateral jsonb_array_elements(r.drink_items) d(item)
    where r.drink_items is not null
  ), adjusted as (
    select priced.*,
           cost_pence::bigint - sum(price) over (partition by round_id) as difference,
           row_number() over (partition by round_id order by person_id) as rank
    from priced
  ), drink_allocated as (
    select person_id,
           price + floor(difference::numeric / attendee_count)::bigint
           + case when rank <= difference
             - floor(difference::numeric / attendee_count)::bigint * attendee_count
             then 1 else 0 end as share
    from adjusted
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

revoke all on function private.coffee_validate_drinks(uuid[],integer,jsonb),
  private.coffee_balances() from public, anon, authenticated;

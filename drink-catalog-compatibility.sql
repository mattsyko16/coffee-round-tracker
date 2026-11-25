-- Accept the previous page's lowercase default drink labels during rollout.
create or replace function private.coffee_validate_catalog_drinks(p_drinks jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_array_elements(p_drinks) d(item)
    where not exists (
      select 1 from public.coffee_drinks c
      where c.active and lower(c.name) = lower(d.item->>'drink')
    )
  ) then
    raise exception 'Choose a drink from the current price list' using errcode = '22023';
  end if;
end;
$$;
revoke all on function private.coffee_validate_catalog_drinks(jsonb)
  from public, anon, authenticated;


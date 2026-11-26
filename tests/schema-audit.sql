-- Read-only permission audit. Run after the schema and all coffee migrations.
do $$
declare t text; f text;
begin
  foreach t in array array['coffee_settings','coffee_members','coffee_people','coffee_rounds','coffee_drinks','coffee_revision'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'RLS is off for %', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'anon has table access to %', t;
    end if;
    if has_table_privilege('authenticated', 'public.' || t, 'INSERT,UPDATE,DELETE') then
      raise exception 'authenticated can write % directly', t;
    end if;
  end loop;
  if has_table_privilege('authenticated','public.coffee_settings','SELECT')
     or has_table_privilege('authenticated','public.coffee_people','SELECT')
     or has_table_privilege('authenticated','public.coffee_rounds','SELECT')
     or has_table_privilege('authenticated','public.coffee_drinks','SELECT') then
    raise exception 'A private table is readable directly';
  end if;
  foreach f in array array[
    'coffee_join(text,text)','coffee_snapshot()','coffee_preview(uuid[])',
    'coffee_add_person(text)','coffee_archive_person(uuid)',
    'coffee_record_round(uuid,uuid[],integer,date,uuid)',
    'coffee_record_round_itemized(uuid,uuid[],integer,date,uuid,jsonb)',
    'coffee_delete_round(uuid)','coffee_import_legacy(jsonb,jsonb)',
    'coffee_add_drink(text,integer)','coffee_set_drink_price(uuid,integer,integer)',
    'coffee_archive_drink(uuid)','coffee_import_with_catalog(jsonb,jsonb,jsonb)'
  ] loop
    if has_function_privilege('anon','public.' || f,'EXECUTE') then
      raise exception 'anon can execute %', f;
    end if;
    if not has_function_privilege('authenticated','public.' || f,'EXECUTE') then
      raise exception 'member RPC not executable: %', f;
    end if;
    if not (select prosecdef and 'search_path=' = any(proconfig)
            from pg_proc where oid = ('public.' || f)::regprocedure) then
      raise exception 'RPC lacks pinned definer settings: %', f;
    end if;
  end loop;
  if has_function_privilege('anon','private.coffee_validate_drinks(uuid[],integer,jsonb)','EXECUTE')
     or has_function_privilege('authenticated','private.coffee_validate_drinks(uuid[],integer,jsonb)','EXECUTE')
     or has_function_privilege('anon','private.coffee_validate_catalog_drinks(jsonb)','EXECUTE')
     or has_function_privilege('authenticated','private.coffee_validate_catalog_drinks(jsonb)','EXECUTE') then
    raise exception 'Drink validator is callable directly';
  end if;
  raise notice 'Coffee permission audit passed';
end $$;


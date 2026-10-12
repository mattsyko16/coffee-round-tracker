-- Read-only permission audit. Run after supabase.sql in a disposable Supabase project.
do $$
declare t text; f text;
begin
  foreach t in array array['coffee_settings','coffee_members','coffee_people','coffee_rounds','coffee_revision'] loop
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
     or has_table_privilege('authenticated','public.coffee_rounds','SELECT') then
    raise exception 'A private table is readable directly';
  end if;
  foreach f in array array[
    'coffee_join(text,text)','coffee_snapshot()','coffee_preview(uuid[])',
    'coffee_add_person(text)','coffee_archive_person(uuid)',
    'coffee_record_round(uuid,uuid[],integer,date,uuid)',
    'coffee_delete_round(uuid)','coffee_import_legacy(jsonb,jsonb)'
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
  raise notice 'Coffee permission audit passed';
end $$;


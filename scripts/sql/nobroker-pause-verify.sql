-- Read-only check after 20261127200200_nobroker_pause.sql. Every row must say pass = true.
select 'paused_at column exists, timestamptz, nullable, no default' as check_name,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'nobroker_integrations' and column_name = 'paused_at'
      and data_type = 'timestamp with time zone' and is_nullable = 'YES' and column_default is null
  ) as pass
union all
select 'no NoBroker URL is paused right after applying',
  not exists (select 1 from public.nobroker_integrations where paused_at is not null)
union all
select 'find_nobroker_integration skips a paused URL on both lines',
  (select (length(d) - length(replace(d, 'i.paused_at is null', ''))) / length('i.paused_at is null') = 2
   from (select pg_get_functiondef('public.find_nobroker_integration'::regproc) as d) as f)
union all
select 'find_nobroker_integration is still security definer with an empty search_path',
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
   where p.oid = 'public.find_nobroker_integration'::regproc)
union all
select 'find_nobroker_integration can be run only by postgres and service_role',
  (select array_agg(a::text order by a::text) from pg_proc p, unnest(p.proacl) as a
   where p.oid = 'public.find_nobroker_integration'::regproc)
  = array['postgres=X/postgres', 'service_role=X/postgres']
union all
select 'anon / authenticated cannot run find_nobroker_integration',
  not has_function_privilege('anon', 'public.find_nobroker_integration(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.find_nobroker_integration(text)', 'execute');

-- Read-only check after 20261128150400_nobroker_disconnect.sql. Every row must say pass = true.
select 'nobroker_integrations_disconnected_check exists and is validated' as check_name,
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.nobroker_integrations'::regclass and conname = 'nobroker_integrations_disconnected_check'
      and contype = 'c' and convalidated
  ) as pass
union all
select 'no disconnected NoBroker row keeps an old URL or a pause',
  not exists (
    select 1 from public.nobroker_integrations
    where not is_active and (previous_url_token_hash is not null or previous_valid_until is not null or paused_at is not null)
  )
union all
select 'save_nobroker_url carries an old URL and a pause only from an active row (3 case lines)',
  (select (length(d) - length(replace(d, 'case when i.is_active then', ''))) / length('case when i.is_active then') = 3
   from (select pg_get_functiondef('public.save_nobroker_url'::regproc) as d) as f)
union all
select 'save_nobroker_url is still security definer with an empty search_path',
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
   where p.oid = 'public.save_nobroker_url'::regproc)
union all
select 'anon / authenticated cannot run save_nobroker_url',
  not has_function_privilege('anon', 'public.save_nobroker_url(uuid, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_nobroker_url(uuid, text, text)', 'execute')
union all
select 'service_role can still run save_nobroker_url',
  has_function_privilege('service_role', 'public.save_nobroker_url(uuid, text, text)', 'execute')
union all
select 'find_nobroker_integration still refuses an inactive row on both lines',
  (select (length(d) - length(replace(d, 'i.is_active and i.paused_at is null', ''))) / length('i.is_active and i.paused_at is null') = 2
   from (select pg_get_functiondef('public.find_nobroker_integration'::regproc) as d) as f)
union all
select 'ingest_nobroker_lead still requires is_active',
  (select position('i.is_active' in pg_get_functiondef('public.ingest_nobroker_lead'::regproc)) > 0);

-- Read-only check after 20261128150000_99acres_disconnect.sql. Every row must say pass = true.
select 'portal_integrations_disconnected_check exists and is validated' as check_name,
  exists (
    select 1 from pg_constraint
    where conrelid = 'public.portal_integrations'::regclass and conname = 'portal_integrations_disconnected_check'
      and contype = 'c' and convalidated
  ) as pass
union all
select 'no disconnected 99acres row keeps an old URL or a pause',
  not exists (
    select 1 from public.portal_integrations
    where not is_active and (previous_url_token_hash is not null or previous_valid_until is not null or paused_at is not null)
  )
union all
select 'save_portal_url carries an old URL and a pause only from an active row (3 case lines)',
  (select (length(d) - length(replace(d, 'case when i.is_active then', ''))) / length('case when i.is_active then') = 3
   from (select pg_get_functiondef('public.save_portal_url'::regproc) as d) as f)
union all
select 'save_portal_url is still security definer with an empty search_path',
  (select p.prosecdef and p.proconfig = array['search_path=""'] from pg_proc p
   where p.oid = 'public.save_portal_url'::regproc)
union all
select 'anon / authenticated cannot run save_portal_url',
  not has_function_privilege('anon', 'public.save_portal_url(uuid, text, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'public.save_portal_url(uuid, text, text, text)', 'execute')
union all
select 'service_role can still run save_portal_url',
  has_function_privilege('service_role', 'public.save_portal_url(uuid, text, text, text)', 'execute')
union all
select 'find_portal_integration still refuses an inactive row on both lines',
  (select (length(d) - length(replace(d, 'i.is_active and i.paused_at is null', ''))) / length('i.is_active and i.paused_at is null') = 2
   from (select pg_get_functiondef('public.find_portal_integration'::regproc) as d) as f)
union all
select 'ingest_portal_lead_on_url still requires is_active',
  (select position('i.is_active' in pg_get_functiondef('public.ingest_portal_lead_on_url'::regproc)) > 0);

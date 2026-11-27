-- Read-only check after 20261127170000_custom_webhook_pause.sql. Every row must say pass = true.
select 'paused_at column exists, timestamptz, nullable, no default' as check_name,
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'custom_lead_webhooks' and column_name = 'paused_at'
      and data_type = 'timestamp with time zone' and is_nullable = 'YES' and column_default is null
  ) as pass
union all
select 'no webhook is paused right after applying',
  not exists (select 1 from public.custom_lead_webhooks where paused_at is not null)
union all
select 'anon / authenticated still have no access to custom_lead_webhooks',
  not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'custom_lead_webhooks' and grantee in ('anon', 'authenticated')
  )
union all
select 'service_role keeps select, insert, update only',
  (select array_agg(privilege_type::text order by privilege_type) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'custom_lead_webhooks' and grantee = 'service_role')
  = array['INSERT', 'SELECT', 'UPDATE'];

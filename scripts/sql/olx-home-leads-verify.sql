-- Read-only check after applying supabase/migrations/20261127120000_olx_home_leads.sql. Changes nothing.
-- Every row must say ok = true. The last query lists leads per source; it must match the counts taken before applying.

with live as (
  select pg_get_constraintdef(oid) as def from pg_constraint
  where conrelid = 'public.lead_data'::regclass and conname = 'lead_data_source_fields_check'
), before as (
  -- lead_data_source_fields_check as live on prod before the migration (pg_get_constraintdef, read 2026-11-27).
  select 'CHECK ((((lead_source = ''facebook''::text) AND (webhook_notification_event_id IS NOT NULL) AND (leadgen_id IS NOT NULL) AND (facebook_page_record_id IS NOT NULL) AND (facebook_page_id IS NOT NULL) AND (form_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''telecaller''::text) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (raw_lead_payload IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''google_ads''::text) AND (google_lead_event_id IS NOT NULL) AND (google_lead_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (ad_id IS NULL)) OR ((lead_source = ''custom_webhook''::text) AND (custom_webhook_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''99acres''::text) AND (portal_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''magicbricks''::text) AND (magicbricks_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''housing''::text) AND (housing_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''sulekha''::text) AND (sulekha_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL)) OR ((lead_source = ''nobroker''::text) AND (nobroker_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL) AND (webhook_notification_event_id IS NULL) AND (leadgen_id IS NULL) AND (facebook_page_record_id IS NULL) AND (facebook_page_id IS NULL) AND (form_id IS NULL) AND (ad_id IS NULL) AND (google_lead_event_id IS NULL) AND (google_lead_id IS NULL) AND (google_campaign_id IS NULL))))'::text as def
)
select 'facebook / telecaller / google_ads / custom_webhook / 99acres / magicbricks / housing / sulekha / nobroker branches unchanged' as check_name,
  position(left(before.def, length(before.def) - 2) in live.def) = 1 as ok from live, before
union all
select 'olx_home branch added at the end', live.def like '% OR ((lead_source = ''olx_home''::text) AND (olx_home_integration_id IS NOT NULL) AND (raw_lead_payload IS NOT NULL)%' from live
union all
select 'lead_source check allows olx_home',
  pg_get_constraintdef(oid) = 'CHECK ((lead_source = ANY (ARRAY[''facebook''::text, ''telecaller''::text, ''google_ads''::text, ''custom_webhook''::text, ''99acres''::text, ''magicbricks''::text, ''housing''::text, ''sulekha''::text, ''nobroker''::text, ''olx_home''::text])))'
  from pg_constraint where conrelid = 'public.lead_data'::regclass and conname = 'lead_data_lead_source_check'
union all
select 'every lead_data constraint validated', not exists (select 1 from pg_constraint where conrelid = 'public.lead_data'::regclass and not convalidated)
union all
select 'olx_home fields check + integration FK present', (select count(*) from pg_constraint where conrelid = 'public.lead_data'::regclass and conname in ('lead_data_olx_home_fields_check', 'lead_data_olx_home_integration_fk')) = 2
union all
select '99acres + magicbricks + housing + sulekha + nobroker fields checks + FKs still present', (select count(*) from pg_constraint where conrelid = 'public.lead_data'::regclass and conname in ('lead_data_portal_fields_check', 'lead_data_portal_integration_fk', 'lead_data_magicbricks_fields_check', 'lead_data_magicbricks_integration_fk', 'lead_data_housing_fields_check', 'lead_data_housing_integration_fk', 'lead_data_sulekha_fields_check', 'lead_data_sulekha_integration_fk', 'lead_data_nobroker_fields_check', 'lead_data_nobroker_integration_fk')) = 10
union all
select 'log -> lead FK clears only parsed_lead_id', pg_get_constraintdef(oid) like '%ON DELETE SET NULL (parsed_lead_id)'
  from pg_constraint where conrelid = 'public.olx_home_webhook_logs'::regclass and conname = 'olx_home_webhook_logs_parsed_lead_fk'
union all
select 'service_role reads the new lead_data columns; anon/authenticated do not',
  has_column_privilege('service_role', 'public.lead_data', 'olx_home_lead_ref', 'select') and has_column_privilege('service_role', 'public.lead_data', 'olx_home_project_name', 'select')
  and has_column_privilege('service_role', 'public.lead_data', 'olx_home_integration_id', 'select')
  and not has_column_privilege('anon', 'public.lead_data', 'olx_home_lead_ref', 'select') and not has_column_privilege('authenticated', 'public.lead_data', 'olx_home_lead_ref', 'select')
union all
select 'RLS forced on both new tables', (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in ('public.olx_home_integrations'::regclass, 'public.olx_home_webhook_logs'::regclass))
union all
select 'no policies on the new tables (service role only)', not exists (select 1 from pg_policy where polrelid in ('public.olx_home_integrations'::regclass, 'public.olx_home_webhook_logs'::regclass))
union all
select 'anon/authenticated have no table access', not (has_table_privilege('anon', 'public.olx_home_integrations', 'select') or has_table_privilege('authenticated', 'public.olx_home_integrations', 'select')
  or has_table_privilege('anon', 'public.olx_home_webhook_logs', 'select') or has_table_privilege('authenticated', 'public.olx_home_webhook_logs', 'select'))
union all
select 'service_role cannot delete logs or integrations', not (has_table_privilege('service_role', 'public.olx_home_webhook_logs', 'delete') or has_table_privilege('service_role', 'public.olx_home_integrations', 'delete'))
union all
select 'old-URL hash has its own unique index', exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'olx_home_integrations_previous_hash_key')
union all
select fn || ': service_role only, security definer, empty search_path',
  has_function_privilege('service_role', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
  and p.prosecdef and p.proconfig = array['search_path=""']
  from (values ('public.ingest_olx_home_lead(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)'), ('public.find_olx_home_integration(text)'), ('public.save_olx_home_url(uuid,text,text)')) as f(fn)
  join pg_proc p on p.oid = f.fn::regprocedure
union all
select 'purge function private to postgres', not has_function_privilege('service_role', 'private.purge_olx_home_webhook_logs()', 'execute')
union all
select 'nightly purge job at 23:15 GMT (04:45 IST)', exists (select 1 from cron.job where jobname = 'crm-olx-home-webhook-log-purge' and schedule = '15 23 * * *' and active)
union all
select '99acres + magicbricks + housing + sulekha + nobroker purge jobs unchanged', (select count(*) from cron.job where (jobname = 'crm-portal-webhook-log-purge' and schedule = '0 22 * * *' and active) or (jobname = 'crm-magicbricks-webhook-log-purge' and schedule = '15 22 * * *' and active) or (jobname = 'crm-housing-webhook-log-purge' and schedule = '30 22 * * *' and active) or (jobname = 'crm-sulekha-webhook-log-purge' and schedule = '45 22 * * *' and active) or (jobname = 'crm-nobroker-webhook-log-purge' and schedule = '0 23 * * *' and active)) = 5;

select lead_source, count(*) from public.lead_data group by lead_source order by lead_source;

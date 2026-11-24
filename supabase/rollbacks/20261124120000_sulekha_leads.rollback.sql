-- ROLLBACK for supabase/migrations/20261124120000_sulekha_leads.sql. Never applied automatically: this folder is not
-- supabase/migrations. Run by hand, only on the owner's explicit OK, only if the Sulekha migration has to be undone.
--
-- What it restores, exactly as live on prod before the Sulekha migration (read 2026-11-24 with pg_get_constraintdef):
--   lead_data_lead_source_check     facebook | telecaller | google_ads | custom_webhook | 99acres | magicbricks | housing
--   lead_data_source_fields_check   facebook, telecaller, google_ads, custom_webhook, 99acres, magicbricks and housing
--                                   branches, unchanged text
-- and drops every object the Sulekha migration created, including its nightly log purge job. No other platform's
-- object is touched.
--
-- ORDER: the app code on branch feature/sulekha-leads reads lead_data.sulekha_lead_ref and sulekha_service_name on the
-- leads page. If that code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this while
-- that code is live breaks the leads page for every company and every source.
--
-- Safety: it refuses to run while any Sulekha lead exists, because the restored checks would reject those rows.
-- Deleting customer leads is a separate decision for the owner, never part of a rollback. The notes the intake added to
-- other leads ("New Sulekha enquiry ...") are ordinary timeline rows and stay.
--
-- Locks: ALTER TABLE lead_data takes ACCESS EXCLUSIVE for the few milliseconds the catalog changes need; the restored
-- checks are added NOT VALID and validated afterwards (SHARE UPDATE EXCLUSIVE, does not block reads or writes).

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.lead_data where lead_source = 'sulekha' or sulekha_integration_id is not null) then
    raise exception 'Sulekha leads exist; rollback refused. Decide what to do with them first.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crm-sulekha-webhook-log-purge') then
    perform cron.unschedule('crm-sulekha-webhook-log-purge');
  end if;
end;
$$;

drop function if exists private.purge_sulekha_webhook_logs();
drop function if exists public.ingest_sulekha_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb);
drop function if exists public.find_sulekha_integration(text);
drop function if exists public.save_sulekha_url(uuid, text, text);

-- The log table references lead_data and sulekha_integrations; drop it before both are changed.
drop table if exists public.sulekha_webhook_logs;

alter table public.lead_data drop constraint if exists lead_data_sulekha_fields_check;
alter table public.lead_data drop constraint if exists lead_data_sulekha_integration_fk;

alter table public.lead_data drop constraint lead_data_source_fields_check;
alter table public.lead_data add constraint lead_data_source_fields_check check (
  (lead_source = 'facebook'
    and webhook_notification_event_id is not null and leadgen_id is not null
    and facebook_page_record_id is not null and facebook_page_id is not null
    and form_id is not null and raw_lead_payload is not null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'telecaller'
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and raw_lead_payload is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'google_ads'
    and google_lead_event_id is not null and google_lead_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null and ad_id is null)
  or
  (lead_source = 'custom_webhook'
    and custom_webhook_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = '99acres'
    and portal_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'magicbricks'
    and magicbricks_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
  or
  (lead_source = 'housing'
    and housing_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook', '99acres', 'magicbricks', 'housing')) not valid;

drop index if exists public.lead_data_tenant_sulekha_integration_idx;

alter table public.lead_data
  drop column if exists sulekha_integration_id,
  drop column if exists sulekha_lead_ref,
  drop column if exists sulekha_service_name;

drop table if exists public.sulekha_integrations;

notify pgrst, 'reload schema';

commit;

alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;

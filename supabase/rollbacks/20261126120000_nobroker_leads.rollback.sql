-- ROLLBACK for supabase/migrations/20261126120000_nobroker_leads.sql. Never applied automatically: this folder is not
-- supabase/migrations. Run by hand, only on the owner's explicit OK, only if the NoBroker migration has to be undone.
--
-- What it restores, exactly as live on prod before the NoBroker migration (read 2026-11-26 with
-- pg_get_constraintdef):
--   lead_data_lead_source_check     facebook | telecaller | google_ads | custom_webhook | 99acres | magicbricks |
--                                   housing | sulekha
--   lead_data_source_fields_check   facebook, telecaller, google_ads, custom_webhook, 99acres, magicbricks, housing and
--                                   sulekha branches, unchanged text
-- and drops every object the NoBroker migration created, including its nightly log purge job. No other platform's
-- object is touched.
--
-- ORDER: the app code on branch feature/nobroker-leads reads lead_data.nobroker_lead_ref and nobroker_project_name on the
-- leads page. If that code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this while
-- that code is live breaks the leads page for every company and every source.
--
-- Safety: it refuses to run while any NoBroker lead exists, because the restored checks would reject those rows.
-- Deleting customer leads is a separate decision for the owner, never part of a rollback. The notes the intake added to
-- other leads ("New NoBroker enquiry ...") are ordinary timeline rows and stay.
--
-- Locks: ALTER TABLE lead_data takes ACCESS EXCLUSIVE for the few milliseconds the catalog changes need; the restored
-- checks are added NOT VALID and validated afterwards (SHARE UPDATE EXCLUSIVE, does not block reads or writes).

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.lead_data where lead_source = 'nobroker' or nobroker_integration_id is not null) then
    raise exception 'NoBroker leads exist; rollback refused. Decide what to do with them first.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crm-nobroker-webhook-log-purge') then
    perform cron.unschedule('crm-nobroker-webhook-log-purge');
  end if;
end;
$$;

drop function if exists private.purge_nobroker_webhook_logs();
drop function if exists public.ingest_nobroker_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb);
drop function if exists public.find_nobroker_integration(text);
drop function if exists public.save_nobroker_url(uuid, text, text);

-- The log table references lead_data and nobroker_integrations; drop it before both are changed.
drop table if exists public.nobroker_webhook_logs;

alter table public.lead_data drop constraint if exists lead_data_nobroker_fields_check;
alter table public.lead_data drop constraint if exists lead_data_nobroker_integration_fk;

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
  or
  (lead_source = 'sulekha'
    and sulekha_integration_id is not null and raw_lead_payload is not null
    and webhook_notification_event_id is null and leadgen_id is null
    and facebook_page_record_id is null and facebook_page_id is null
    and form_id is null and ad_id is null
    and google_lead_event_id is null and google_lead_id is null and google_campaign_id is null)
) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook', '99acres', 'magicbricks', 'housing', 'sulekha')) not valid;

drop index if exists public.lead_data_tenant_nobroker_integration_idx;

alter table public.lead_data
  drop column if exists nobroker_integration_id,
  drop column if exists nobroker_lead_ref,
  drop column if exists nobroker_project_name;

drop table if exists public.nobroker_integrations;

notify pgrst, 'reload schema';

commit;

alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;

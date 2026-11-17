-- ROLLBACK for supabase/migrations/20261117120000_portal_leads_99acres.sql. Never applied automatically: this folder is
-- not supabase/migrations. Run by hand, only on the owner's explicit OK, only if the portal leads migration has to be
-- undone.
--
-- What it restores, exactly as live on prod before the portal leads migration (read 2026-11-17 with
-- pg_get_constraintdef):
--   lead_data_lead_source_check     facebook | telecaller | google_ads | custom_webhook
--   lead_data_source_fields_check   facebook, telecaller, google_ads and custom_webhook branches, unchanged text
-- and drops every object the portal leads migration created, including the nightly log purge job.
--
-- ORDER: the app code on branch feature/99acres-portal-leads reads lead_data.portal_lead_ref and portal_project_name on
-- the leads page. If that code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this while
-- that code is live breaks the leads page for every tenant, Meta and Google leads included.
--
-- Safety: it refuses to run while any 99acres lead exists, because the restored checks would reject those rows.
-- Deleting customer leads is a separate decision for the owner, never part of a rollback. (If the owner decides to
-- delete them: lead_activities, lead_label_classifications, lead_notes and lead_tasks cascade with the lead, but
-- lead_project_assignment_audit is NO ACTION, so its rows for those leads must be removed first.) The notes the intake
-- added to other leads ("New 99acres enquiry ...") are ordinary timeline rows and stay.
--
-- Locks: ALTER TABLE lead_data takes ACCESS EXCLUSIVE for the few milliseconds the catalog changes need; the restored
-- checks are added NOT VALID and validated afterwards (SHARE UPDATE EXCLUSIVE, does not block reads or writes).

begin;
set local lock_timeout = '5s';

do $$
begin
  if exists (select 1 from public.lead_data where lead_source = '99acres' or portal_integration_id is not null) then
    raise exception '99acres leads exist; rollback refused. Decide what to do with them first.';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'crm-portal-webhook-log-purge') then
    perform cron.unschedule('crm-portal-webhook-log-purge');
  end if;
end;
$$;

drop function if exists private.purge_portal_webhook_logs();
drop function if exists public.ingest_portal_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, boolean);

-- The log table references lead_data and portal_integrations; drop it before both are changed.
drop table if exists public.portal_webhook_logs;

alter table public.lead_data drop constraint if exists lead_data_portal_fields_check;
alter table public.lead_data drop constraint if exists lead_data_portal_integration_fk;

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
) not valid;

alter table public.lead_data drop constraint lead_data_lead_source_check;
alter table public.lead_data add constraint lead_data_lead_source_check
  check (lead_source in ('facebook', 'telecaller', 'google_ads', 'custom_webhook')) not valid;

drop index if exists public.lead_data_tenant_portal_integration_idx;

alter table public.lead_data
  drop column if exists portal_integration_id,
  drop column if exists portal_lead_ref,
  drop column if exists portal_project_name;

drop table if exists public.portal_integrations;

notify pgrst, 'reload schema';

commit;

alter table public.lead_data validate constraint lead_data_lead_source_check;
alter table public.lead_data validate constraint lead_data_source_fields_check;

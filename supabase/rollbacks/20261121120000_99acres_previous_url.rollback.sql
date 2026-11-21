-- ROLLBACK for supabase/migrations/20261121120000_99acres_previous_url.sql. Never applied automatically: this folder is
-- not supabase/migrations. Run by hand, only on the owner's explicit OK, only if the 99acres 7-day handover has to be
-- undone.
--
-- What it does: drops the three functions the migration created (save_portal_url, find_portal_integration,
-- ingest_portal_lead_on_url), the url_version log column and the previous_* columns with their checks and index. After
-- it the old URL of every 99acres integration is refused at once again, as before the migration. ingest_portal_lead was
-- never changed by the migration, so nothing has to be restored. No other platform's object is touched.
--
-- ORDER: the app code from branch feature/portal-old-url-7-days calls the three dropped functions for 99acres. If that
-- code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this while that code is live
-- stops every 99acres lead (the webhook answers 500 and 99acres retries).
--
-- No lead is deleted: leads saved from an old URL are ordinary 99acres leads and stay.

begin;
set local lock_timeout = '5s';

drop function public.ingest_portal_lead_on_url(uuid, uuid, uuid, text, text, text, text, text, jsonb, jsonb, boolean);
drop function public.find_portal_integration(text, text);
drop function public.save_portal_url(uuid, text, text, text);

alter table public.portal_webhook_logs drop column url_version;

drop index public.portal_integrations_previous_hash_key;
alter table public.portal_integrations drop constraint portal_integrations_previous_differs_check;
alter table public.portal_integrations drop constraint portal_integrations_previous_pair_check;
alter table public.portal_integrations
  drop column previous_last_received_at,
  drop column previous_valid_until,
  drop column previous_url_token_hash;

notify pgrst, 'reload schema';

commit;

-- ROLLBACK for supabase/migrations/20261121130000_magicbricks_previous_url.sql. Never applied automatically: this
-- folder is not supabase/migrations. Run by hand, only on the owner's explicit OK, only if the MagicBricks 7-day
-- handover has to be undone.
--
-- What it does: drops the three functions the migration created (save_magicbricks_url, find_magicbricks_integration,
-- ingest_magicbricks_lead_on_url), the url_version log column and the previous_* columns with their checks and index.
-- After it the old URL of every MagicBricks integration is refused at once again, as before the migration.
-- ingest_magicbricks_lead was never changed by the migration, so nothing has to be restored. No other platform's object
-- is touched.
--
-- ORDER: the app code from branch feature/portal-old-url-7-days calls the three dropped functions for MagicBricks. If
-- that code is live, revert/redeploy the app WITHOUT it first, then run this file. Running this while that code is
-- live stops every MagicBricks lead (the webhook answers 500 and MagicBricks retries).
--
-- No lead is deleted: leads saved from an old URL are ordinary MagicBricks leads and stay.

begin;
set local lock_timeout = '5s';

drop function public.ingest_magicbricks_lead_on_url(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb);
drop function public.find_magicbricks_integration(text);
drop function public.save_magicbricks_url(uuid, text, text);

alter table public.magicbricks_webhook_logs drop column url_version;

drop index public.magicbricks_integrations_previous_hash_key;
alter table public.magicbricks_integrations drop constraint magicbricks_integrations_previous_differs_check;
alter table public.magicbricks_integrations drop constraint magicbricks_integrations_previous_pair_check;
alter table public.magicbricks_integrations
  drop column previous_last_received_at,
  drop column previous_valid_until,
  drop column previous_url_token_hash;

notify pgrst, 'reload schema';

commit;

-- 99acres: drop the old lead writer ingest_portal_lead (20261117120000). Since 20261121120000 the app saves every
-- 99acres lead with ingest_portal_lead_on_url (it also checks which URL the lead came on); the old one was kept only
-- for the minutes between that migration and the deploy of main 8949e78 (live since 2026-11-21 13:12 IST).
--
-- Checked on prod before writing this (2026-11-21): no app code, database function, trigger, view or cron job calls it.
-- 99acres objects only: nothing of MagicBricks, Housing.com, Facebook, Google Ads, call-in or the custom webhook.
--
-- Undo: supabase/rollbacks/20261121140000_99acres_drop_old_lead_writer.rollback.sql (recreates it exactly). Needed only
-- if the app is rolled back to a version before main 8949e78, which still calls the old function.

begin;
set local lock_timeout = '5s';

drop function public.ingest_portal_lead(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb, boolean);

notify pgrst, 'reload schema';

commit;

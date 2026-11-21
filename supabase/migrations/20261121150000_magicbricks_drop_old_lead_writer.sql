-- MagicBricks: drop the old lead writer ingest_magicbricks_lead (20261118170000). Since 20261121130000 the app saves
-- every MagicBricks lead with ingest_magicbricks_lead_on_url (it also checks which URL the lead came on); the old one
-- was kept only for the minutes between that migration and the deploy of main 8949e78 (live since 2026-11-21
-- 13:12 IST).
--
-- Checked on prod before writing this (2026-11-21): no app code, database function, trigger, view or cron job calls it.
-- MagicBricks objects only: nothing of 99acres, Housing.com, Facebook, Google Ads, call-in or the custom webhook.
--
-- Undo: supabase/rollbacks/20261121150000_magicbricks_drop_old_lead_writer.rollback.sql (recreates it exactly).
-- Needed only if the app is rolled back to a version before main 8949e78, which still calls the old function.

begin;
set local lock_timeout = '5s';

drop function public.ingest_magicbricks_lead(uuid, uuid, uuid, text, text, text, jsonb, jsonb);

notify pgrst, 'reload schema';

commit;

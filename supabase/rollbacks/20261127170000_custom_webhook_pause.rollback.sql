-- Undo 20261127170000_custom_webhook_pause.sql. Deploy the app without Pause first: the Pause app reads paused_at.
-- A paused webhook starts receiving leads again once the column is gone.
begin;
set local lock_timeout = '5s';
alter table public.custom_lead_webhooks drop column if exists paused_at;
commit;

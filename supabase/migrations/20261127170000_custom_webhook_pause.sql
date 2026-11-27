-- Pause / Resume for the custom webhook (Custom webhook only; no other platform's table or function is touched).
--
-- custom_lead_webhooks.paused_at: NULL = receiving leads; set = the owner paused them at that time. While it is set, the
-- webhook route answers every request to the URL with 404 "Unknown webhook." (the same as a wrong URL) and reads,
-- logs and saves nothing (custom-lead-webhook-service.ts). Resume sets it back to NULL. Replace URL keeps it; Stop
-- clears it (custom-webhook-connection-service.ts).
--
-- Existing rows: NULL, so every webhook keeps receiving leads exactly as before. The running app does not read the
-- column, so applying this before the new app is live changes nothing.
--
-- Grants: service_role already has select, insert, update on the table (20261111170000_custom_webhook_leads.sql);
-- anon / authenticated have none. Nothing to change.
--
-- Undo: supabase/rollbacks/20261127170000_custom_webhook_pause.rollback.sql.
-- Check after applying (read-only): scripts/sql/custom-webhook-pause-verify.sql.
--
-- Locks: adding a nullable column with no default is a catalog-only change (milliseconds). lock_timeout makes it fail
-- and roll back cleanly instead of queueing webhook requests behind a long query.

begin;
set local lock_timeout = '5s';

alter table public.custom_lead_webhooks add column paused_at timestamptz;

comment on column public.custom_lead_webhooks.paused_at is
  'NULL = receiving leads. Set = the owner paused webhook leads at this time: every request to the URL is refused (404) and nothing is saved.';

commit;

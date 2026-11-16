-- Undo 20261116170000_retry_failed_facebook_leads_nightly.sql.
-- Removes the nightly job, its function and its index. Nothing else changes.
-- Leads it already put back in the queue simply continue through the normal pipeline.

select cron.unschedule(jobid) from cron.job where jobname = 'crm-facebook-failed-lead-retry';

drop function if exists private.retry_failed_facebook_leads(integer);

drop index if exists public.meta_webhook_events_dead_letter_retry_idx;

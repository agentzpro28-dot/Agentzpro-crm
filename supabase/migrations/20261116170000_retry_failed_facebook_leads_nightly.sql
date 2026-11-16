-- Nightly retry of failed Facebook leads.
--
-- A Facebook lead whose fetch failed for good stays in meta_webhook_notification_events with
-- processing_status = 'dead_letter'. It is written by schedule_meta_lead_retrieval_retry, or by
-- recover_meta_webhook_notification_events when a worker lease expires. Until now only dead letters caused by a
-- Facebook authorization failure were ever retried (release_reauthorization_dead_letter_meta_events, on reconnect),
-- so every other failed lead never reached the CRM. Meta keeps lead data for 90 days after the form is submitted,
-- so the lead can still be fetched by its leadgen_id.
--
-- Every night at 00:00 India time this job puts those leads back in the queue: 18:30 GMT, because cron.timezone is
-- GMT. Nothing new fetches or saves a lead. The every-minute crm-lead-recovery job dispatches them like any lead
-- whose first dispatch failed. The existing worker (/api/queues/meta/lead-retrieval) then fetches each one by
-- leadgen_id and saves it through complete_meta_lead_retrieval_event. The lead reaches lead_data exactly like every
-- other Facebook lead: the same dedup, ad-name cache, assignment rule, AI label, timeline and live signal.
--
-- Additive only: one partial index, one function and one cron job. No existing function, trigger, constraint,
-- status, cron job or app code is changed. Google Ads and custom-webhook leads are not involved, because they
-- arrive complete and are never fetched back.
--
-- A lead is picked only when all of these hold:
--   * processing_status = 'dead_letter'.
--   * last_error_code is not META_LEAD_NOT_AVAILABLE. That code means the worker confirmed, with the Page token,
--     that the lead was deleted on Facebook, so a retry can never succeed.
--   * The lead was created within the last 85 days (Meta keeps 90, so 5 days of margin).
--   * The company's Page row still exists for the same company and Page id, and is active with an active token.
--     A paused Page is left to the reconnect flow, which already releases its leads. A reauthorization dead letter
--     whose Page is active again is included, as the safety net for a reconnect whose release did not run.
--
-- One try per lead per night: retrieval_attempt_count is set to 5. claim_meta_webhook_notification_event only
-- claims while the count is below 6 and adds 1. schedule_meta_lead_retrieval_retry dead-letters at 6 or more, and
-- so does the lease-expiry path of recover_meta_webhook_notification_events. The lead therefore gets exactly one
-- fetch. If that fetch fails, the lead goes straight back to dead_letter with the new error and is tried again the
-- next night. scripts/sql/facebook-failed-lead-retry-verify.sql fails if those limits change.
--
-- At most p_limit leads a night (200 by default), least recently tried first. The job can never flood the queue,
-- and a backlog is worked through across nights without newer failures waiting behind leads that keep failing.
-- FOR UPDATE OF event SKIP LOCKED locks only the event rows, never a facebook_pages row, and a row another session
-- holds is left for the next night instead of waited on.
--
-- Undo: supabase/rollbacks/20261116170000_retry_failed_facebook_leads_nightly.rollback.sql
-- Check after applying (read-only): scripts/sql/facebook-failed-lead-retry-verify.sql

-- Only dead letters, in the order the job reads them. The pipeline's own statuses (pending, processing,
-- retry_scheduled, completed) never enter this index, so a new lead costs it nothing.
create index if not exists meta_webhook_events_dead_letter_retry_idx
  on public.meta_webhook_notification_events (last_retrieval_attempt_at nulls first, id)
  where processing_status = 'dead_letter';

-- What the nightly cron job runs. Returns how many failed leads were queued for one more fetch.
create or replace function private.retry_failed_facebook_leads(p_limit integer default 200)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_queued integer;
begin
  with candidate as (
    select event.id
    from public.meta_webhook_notification_events as event
    where event.processing_status = 'dead_letter'
      and event.last_error_code is distinct from 'META_LEAD_NOT_AVAILABLE'
      and event.lead_created_time >= now() - interval '85 days'
      and exists (
        select 1
        from public.facebook_pages as page
        where page.id = event.facebook_page_record_id
          and page.tenant_id = event.tenant_id
          and page.facebook_page_id = event.facebook_page_id
          and page.connection_status = 'active'
          and page.token_status = 'active'
      )
    order by event.last_retrieval_attempt_at nulls first, event.id
    limit greatest(coalesce(p_limit, 0), 0)
    for update of event skip locked
  )
  update public.meta_webhook_notification_events as event
  set processing_status = 'pending',
      retrieval_attempt_count = 5,
      claim_token = null,
      processing_started_at = null,
      next_retrieval_attempt_at = null,
      queue_dispatched_at = null,
      dispatch_generation = gen_random_uuid()
  from candidate
  where event.id = candidate.id
    and event.processing_status = 'dead_letter';
  get diagnostics v_queued = row_count;

  -- Quiet nights stay silent. cron.job_run_details only records "1 row" for a select, so the count is logged here.
  if v_queued > 0 then
    raise warning 'crm-facebook-failed-lead-retry: % failed Facebook lead(s) queued for one more fetch', v_queued;
  end if;
  return v_queued;
end;
$$;

-- Same access as the other private timer functions: only postgres (the cron job owner) may run it.
revoke all on function private.retry_failed_facebook_leads(integer) from public, anon, authenticated, service_role;

-- 00:00 India time (IST = GMT + 5:30; cron.timezone is GMT).
select cron.schedule('crm-facebook-failed-lead-retry', '30 18 * * *',
  $$ select private.retry_failed_facebook_leads() $$);

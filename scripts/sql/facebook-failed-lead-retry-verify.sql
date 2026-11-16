-- Read-only check after applying supabase/migrations/20261116170000_retry_failed_facebook_leads_nightly.sql.
-- Every row of the first result must say ok = true.
--
-- The last three rows guard the "one try per night" rule. The nightly job sets retrieval_attempt_count to 5, which
-- only works while the claim takes tries below 6, and the retry and lease-expiry paths stop at 6.

select checked, ok from (values
  (1, 'function exists',
    to_regprocedure('private.retry_failed_facebook_leads(integer)') is not null),
  (2, 'nightly job runs at 00:00 IST (30 18 * * * GMT)',
    exists (
      select 1 from cron.job
      where jobname = 'crm-facebook-failed-lead-retry'
        and schedule = '30 18 * * *'
        and active
        and command like '%private.retry_failed_facebook_leads()%'
    )),
  (3, 'cron timezone is GMT',
    current_setting('cron.timezone', true) = 'GMT'),
  (4, 'anon, authenticated and service_role cannot run it',
    not has_function_privilege('anon', 'private.retry_failed_facebook_leads(integer)', 'execute')
    and not has_function_privilege('authenticated', 'private.retry_failed_facebook_leads(integer)', 'execute')
    and not has_function_privilege('service_role', 'private.retry_failed_facebook_leads(integer)', 'execute')),
  (5, 'dead-letter index exists',
    to_regclass('public.meta_webhook_events_dead_letter_retry_idx') is not null),
  (6, 'claim takes tries below 6',
    (select bool_and(pg_get_functiondef(p.oid) like '%retrieval_attempt_count < 6%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'claim_meta_webhook_notification_event')),
  (7, 'retry stops at 6',
    (select bool_and(pg_get_functiondef(p.oid) like '%retrieval_attempt_count >= 6%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'schedule_meta_lead_retrieval_retry')),
  (8, 'lease expiry stops at 6',
    (select bool_and(pg_get_functiondef(p.oid) like '%retrieval_attempt_count >= 6 then ''dead_letter''%')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'recover_meta_webhook_notification_events'))
) as checks (n, checked, ok)
order by n;

-- What tonight's run would pick, per company and error. Read-only, same conditions as the function.
select event.tenant_id, event.last_error_code, count(*) as leads, min(event.lead_created_time) as oldest_lead
from public.meta_webhook_notification_events as event
where event.processing_status = 'dead_letter'
  and event.last_error_code is distinct from 'META_LEAD_NOT_AVAILABLE'
  and event.lead_created_time >= now() - interval '85 days'
  and exists (
    select 1 from public.facebook_pages as page
    where page.id = event.facebook_page_record_id
      and page.tenant_id = event.tenant_id
      and page.facebook_page_id = event.facebook_page_id
      and page.connection_status = 'active'
      and page.token_status = 'active'
  )
group by 1, 2
order by 3 desc;

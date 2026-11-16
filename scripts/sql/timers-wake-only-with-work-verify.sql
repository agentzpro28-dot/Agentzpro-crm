-- Read-only check for supabase/migrations/20261116120000_timers_wake_worker_only_with_work.sql. Run it on
-- production right after applying, and again whenever a label or reminder function changes. It reads the
-- catalogs and calls the two read-only work checks; it never wakes a worker and never writes. A clean run ends
-- with the NOTICE 'TIMERS_WAKE_ONLY_WITH_WORK_VERIFIED'.
--
-- The work checks copy the WHERE clauses of the functions the two worker routes call. If one of those functions
-- is ever changed, its body hash below no longer matches and this script fails: update the matching work check
-- in the same change, then update the hash here.

do $$
declare
  v_missing text;
  v_label_work boolean;
  v_reminder_work boolean;
begin
  -- The functions the work checks mirror, exactly as the checks were written against (md5 of prosrc, prod
  -- 2026-11-16, after 20261114120000).
  select string_agg(expected.name, ', ') into v_missing
  from (values
    ('claim_due_label_classification', 'ea2bd5a38bfd21009a87ccde3f0d52de'),
    ('recover_label_classifications', 'a5c529617f05d1db1c6cc9b7f48870ea'),
    ('backfill_missing_label_classifications', '804f48c8f19ed9e411cdcf4ef5abe1b2'),
    ('enqueue_task_reminders', '19b3f9874dd4c2e53ec7cfa40ea42ab9'),
    ('lead_task_owner', '6bbe616c85947eb12fb96f994da01fa1')) as expected(name, body_md5)
  where (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name) <> 1
     or not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name
       and md5(p.prosrc) = expected.body_md5);
  if v_missing is not null then
    raise exception 'Changed since the work checks were written (update the check, then this hash): %', v_missing;
  end if;

  -- The four new functions, exactly as tested, owned by postgres, runnable by postgres only.
  select string_agg(expected.sig, ', ') into v_missing
  from (values
    ('private.label_classification_worker_has_work()', '7f43503e32c877730e1fe973a22a3b27'),
    ('private.task_reminder_worker_has_work()', 'ddc0aa5fe3380d936c30c4d8b127e37f'),
    ('private.run_label_classification_timer(timestamp with time zone)', 'fec8ecb81da4208dbf86e1e5bcddfef5'),
    ('private.run_task_reminder_timer(timestamp with time zone)', '2584a4d398c3b504560880444abaffb4')) as expected(sig, body_md5)
  where to_regprocedure(expected.sig) is null
     or not exists (select 1 from pg_proc p where p.oid = to_regprocedure(expected.sig)
       and md5(p.prosrc) = expected.body_md5 and not p.prosecdef and p.proconfig = array['search_path=""']
       and pg_get_userbyid(p.proowner) = 'postgres')
     or has_function_privilege('anon', expected.sig, 'execute')
     or has_function_privilege('authenticated', expected.sig, 'execute')
     or has_function_privilege('service_role', expected.sig, 'execute');
  if v_missing is not null then raise exception 'Function not as tested or wrong grants: %', v_missing; end if;

  -- The two gated jobs run the timer functions every minute.
  if not exists (select 1 from cron.job where jobname = 'crm-label-classification' and active and schedule = '* * * * *'
      and command = ' select private.run_label_classification_timer() ')
    or not exists (select 1 from cron.job where jobname = 'crm-task-reminders' and active and schedule = '* * * * *'
      and command = ' select private.run_task_reminder_timer() ') then
    raise exception 'crm-label-classification or crm-task-reminders is not running its timer function';
  end if;

  -- Lead pipeline timers untouched: Meta and Google still call their routes every minute, as before.
  if not exists (select 1 from cron.job where jobname = 'crm-lead-recovery' and active and schedule = '* * * * *'
      and command = ' select private.invoke_scheduled_worker(''/api/queues/meta/recovery'') ')
    or not exists (select 1 from cron.job where jobname = 'crm-google-lead-names' and active and schedule = '* * * * *'
      and command = ' select private.invoke_scheduled_worker(''/api/queues/google/lead-names'') ') then
    raise exception 'A lead pipeline timer (crm-lead-recovery or crm-google-lead-names) changed';
  end if;

  -- Both work checks run cleanly on the live tables (read-only).
  v_label_work := private.label_classification_worker_has_work();
  v_reminder_work := private.task_reminder_worker_has_work();

  raise notice 'TIMERS_WAKE_ONLY_WITH_WORK_VERIFIED (label work now: %, reminder work now: %)', v_label_work, v_reminder_work;
end $$;

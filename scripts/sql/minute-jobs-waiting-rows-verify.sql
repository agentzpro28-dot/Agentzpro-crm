-- Read-only check for supabase/migrations/20261114120000_minute_jobs_read_only_waiting_rows.sql, run on production
-- right after it is applied. It only reads catalogs (no fixtures, no writes, no function calls), so it is safe to run
-- at any time. A clean run ends with the NOTICE 'MINUTE_JOBS_WAITING_ROWS_VERIFIED'.
--
-- Behaviour (same reminders to the microsecond, both safety nets, stuck-item recovery, grants, undo) was proven on a
-- local PostgreSQL 17.6 copy with 300,000 leads, 2,000 companies and 60,000 open tasks before applying; production's
-- small tables cannot show index use yet, so this script checks that what was applied is exactly what was tested.
-- The body hashes are md5(prosrc) of the functions as written in the migration file; they change if the file does.

do $$
declare
  v_missing text;
begin
  -- Five indexes, valid and ready.
  select string_agg(name, ', ') into v_missing
  from unnest(array['lead_tasks_open_due_at_idx', 'lead_data_saved_at_idx', 'lead_label_classifications_lease_idx',
    'lead_label_classifications_requeue_idx', 'meta_ads_lease_idx']) as name
  where not exists (select 1 from pg_class c join pg_index i on i.indexrelid = c.oid
    where c.relname = name and c.relnamespace = 'public'::regnamespace and i.indisvalid and i.indisready);
  if v_missing is not null then raise exception 'Missing or invalid index: %', v_missing; end if;

  -- Function bodies exactly as tested, one function per name.
  select string_agg(expected.name, ', ') into v_missing
  from (values
    ('enqueue_task_reminders', '19b3f9874dd4c2e53ec7cfa40ea42ab9'),
    ('backfill_missing_label_classifications', '804f48c8f19ed9e411cdcf4ef5abe1b2'),
    ('recover_meta_ad_name_resolutions', '19e7258ea005d2f7c070880ceaa17ddb'),
    -- Byte-identical to backfill_missing_label_classifications as it ran before this migration.
    ('backfill_all_missing_label_classifications', '2be8505f555191d0909d9a5ee451dbb6'),
    ('backfill_all_missing_lead_ad_names', '0438dee889a68e32da0d268a9bca1d24')) as expected(name, body_md5)
  where (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name) <> 1
     or not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = expected.name
       and md5(p.prosrc) = expected.body_md5 and p.prosecdef and p.proconfig = array['search_path=""']
       and pg_get_userbyid(p.proowner) = 'postgres');
  if v_missing is not null then raise exception 'Function not as tested: %', v_missing; end if;

  -- Only service_role (and the owner) may run them; never anon or authenticated.
  select string_agg(f, ', ') into v_missing
  from unnest(array['public.enqueue_task_reminders(uuid)', 'public.backfill_missing_label_classifications()',
    'public.recover_meta_ad_name_resolutions()', 'public.backfill_all_missing_label_classifications()',
    'public.backfill_all_missing_lead_ad_names()']) as f
  where has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute')
     or not has_function_privilege('service_role', f, 'execute');
  if v_missing is not null then raise exception 'Wrong grants on: %', v_missing; end if;

  -- Nightly jobs, active, in UTC (cron.timezone = GMT): 21:00 UTC = 02:30 IST, 21:15 UTC = 02:45 IST.
  if not exists (select 1 from cron.job where jobname = 'crm-label-classification-nightly-backfill' and active
      and schedule = '0 21 * * *' and command like '%public.backfill_all_missing_label_classifications()%')
    or not exists (select 1 from cron.job where jobname = 'crm-lead-ad-names-nightly-backfill' and active
      and schedule = '15 21 * * *' and command like '%public.backfill_all_missing_lead_ad_names()%') then
    raise exception 'Nightly cron jobs are missing or not as tested';
  end if;

  -- The every-minute jobs are untouched by this migration.
  if (select count(*) from cron.job where active and schedule = '* * * * *' and jobname in
      ('crm-lead-recovery', 'crm-label-classification', 'crm-task-reminders', 'crm-google-lead-names')) <> 4 then
    raise exception 'An every-minute job is missing or inactive';
  end if;

  raise notice 'MINUTE_JOBS_WAITING_ROWS_VERIFIED';
end $$;

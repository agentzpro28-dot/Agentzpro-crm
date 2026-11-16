-- Two every-minute timers wake the Vercel worker only when the worker has something to do.
--
-- Today crm-label-classification and crm-task-reminders POST their worker route every minute, so each idle
-- minute still costs one Vercel wake-up plus 4 database API calls (recover_label_classifications,
-- backfill_missing_label_classifications, claim_due_label_classification, enqueue_task_reminders).
-- After this migration each job first runs a READ-ONLY check inside the database and calls the same route,
-- in the same way, only when that check finds work. The worker routes and every function they call are NOT
-- changed: when the route runs, it does exactly what it does today, and it stays the only writer.
--
-- NOT touched (lead pipeline): crm-lead-recovery (Meta) and crm-google-lead-names (Google) keep calling their
-- routes every minute exactly as before. Lead intake (Meta webhook, Google webhook, custom webhooks, QStash
-- lead retrieval) is not touched either.
--
-- Rules the checks follow:
--   * Same conditions as the worker. Each check copies the WHERE clauses of the functions the route calls
--     (listed per check below), so it is true whenever the route would claim, repair, insert or send anything.
--     scripts/sql/timers-wake-only-with-work-verify.sql fails if any of those functions changes later, so
--     the check is updated with them.
--   * Never stricter than the worker. The route runs a moment after the check, so time limits look 10 seconds
--     ahead and lower bounds use the job's start time. A wrong guess can only cause one extra wake-up, never a
--     missed item.
--   * Fail open. If a check raises an error, the job logs a warning and wakes the worker anyway, as today.
--   * Safety-net run. Every 15 minutes each job wakes its worker unconditionally. That bounds any delay if a
--     future change makes a check miss a case, and it keeps proving in quiet hours that the route, URL and
--     secret still work.
--
-- Scale: each check is a few index range reads (partial indexes below and from 20261114120000), bounded by the
-- waiting rows and the last hour of leads, never by all leads or tasks. When there is work, the first check
-- that finds a row returns at once.
--
-- Undo: supabase/rollbacks/20261116120000_timers_wake_worker_only_with_work.rollback.sql
-- Check after applying (read-only): scripts/sql/timers-wake-only-with-work-verify.sql

-- True when /api/queues/ai/label-classification would do anything. It mirrors, in order:
--   1. claim_due_label_classification   (a due row it would claim)
--   2. recover_label_classifications    (an expired lease it would release)
--   3. recover_label_classifications    (a failed row it would requeue)
--   4. backfill_missing_label_classifications (a lead saved in the last hour with no classification row)
create or replace function private.label_classification_worker_has_work()
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_ahead timestamptz := clock_timestamp() + interval '10 seconds';
begin
  if exists (
    select 1 from public.lead_label_classifications
    where status in ('pending', 'retry_scheduled')
      and next_retry_at <= v_ahead
      and (lease_expires_at is null or lease_expires_at <= v_ahead)
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.lead_label_classifications
    where claim_token is not null and lease_expires_at <= v_ahead
  ) then
    return true;
  end if;

  if exists (
    select 1 from public.lead_label_classifications
    where status = 'failed'
      and label_source <> 'telecaller'
      and requeue_count < 48
      and updated_at <= v_ahead - interval '30 minutes'
  ) then
    return true;
  end if;

  return exists (
    select 1 from public.lead_data as lead
    where lead.created_at >= v_now - interval '1 hour'
      and not exists (
        select 1 from public.lead_label_classifications as classification
        where classification.lead_id = lead.id
      )
  );
end;
$$;

-- True when /api/queues/tasks/reminders would record at least one reminder: the insert of
-- enqueue_task_reminders(), minus the rows its ON CONFLICT (task_notifications_once) would skip.
-- The cheap tests run first (open, inside the window, this reminder not recorded yet). The lead and owner lookups
-- (lead_task_owner reads memberships) run only for those candidates, and the first one that passes returns, so a
-- window full of already-sent reminders never pays for an owner lookup per task.
create or replace function private.task_reminder_worker_has_work()
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_ahead timestamptz := clock_timestamp() + interval '10 seconds';
  v_task record;
begin
  for v_task in
    select t.tenant_id, t.lead_id, t.created_by
    from public.lead_tasks as t
    cross join (values ('due_soon'), ('due_now')) as k(kind)
    where t.status = 'open'
      and t.due_at > v_now - interval '1 hour'
      and t.due_at <= v_ahead + interval '15 minutes'
      and case k.kind
        when 'due_soon' then t.due_at - interval '15 minutes' <= v_ahead and v_now < t.due_at
        else t.due_at <= v_ahead and t.due_at > v_now - interval '1 hour'
      end
      and not exists (
        select 1 from public.task_notifications as n
        where n.task_id = t.id and n.kind = k.kind and n.due_at = t.due_at
      )
  loop
    if exists (
      select 1 from public.lead_data as l
      where l.tenant_id = v_task.tenant_id and l.id = v_task.lead_id
        and public.lead_task_owner(v_task.tenant_id, l.assigned_user_id, v_task.created_by) is not null
    ) then
      return true;
    end if;
  end loop;
  return false;
end;
$$;

-- What the two cron jobs run. p_at is the job's start time; it is a parameter only so tests can choose the
-- minute of the safety-net run. Returns the pg_net request id, or null when the worker was not woken.
create or replace function private.run_label_classification_timer(p_at timestamptz default now())
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_wake boolean := extract(minute from p_at)::integer % 15 = 0;
begin
  if not v_wake then
    begin
      v_wake := private.label_classification_worker_has_work();
    exception when others then
      raise warning 'crm-label-classification: work check failed (SQLSTATE %), waking the worker anyway', sqlstate;
      v_wake := true;
    end;
  end if;

  if v_wake then
    return private.invoke_scheduled_worker('/api/queues/ai/label-classification');
  end if;
  return null;
end;
$$;

create or replace function private.run_task_reminder_timer(p_at timestamptz default now())
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_wake boolean := extract(minute from p_at)::integer % 15 = 0;
begin
  if not v_wake then
    begin
      v_wake := private.task_reminder_worker_has_work();
    exception when others then
      raise warning 'crm-task-reminders: work check failed (SQLSTATE %), waking the worker anyway', sqlstate;
      v_wake := true;
    end;
  end if;

  if v_wake then
    return private.invoke_scheduled_worker('/api/queues/tasks/reminders');
  end if;
  return null;
end;
$$;

-- Same access as private.invoke_scheduled_worker: only postgres (the cron job owner) may run these.
revoke all on function private.label_classification_worker_has_work() from public, anon, authenticated, service_role;
revoke all on function private.task_reminder_worker_has_work() from public, anon, authenticated, service_role;
revoke all on function private.run_label_classification_timer(timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.run_task_reminder_timer(timestamptz) from public, anon, authenticated, service_role;

-- cron.schedule upserts by job name: same job ids, same every-minute schedule, new command.
select cron.schedule('crm-label-classification', '* * * * *',
  $$ select private.run_label_classification_timer() $$);
select cron.schedule('crm-task-reminders', '* * * * *',
  $$ select private.run_task_reminder_timer() $$);

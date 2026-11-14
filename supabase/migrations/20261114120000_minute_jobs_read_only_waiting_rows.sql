-- Every-minute background work: read only the rows that are waiting, not every lead and task of every company.
--
-- Four database functions run every minute (pg_cron -> Vercel worker routes, 20261021120000 and 20261028130000).
-- Checked live on 2026-11-14 (PostgreSQL 17.6, pg_get_functiondef + EXPLAIN): several of them read whole tables on
-- every run, so their cost grew with the total number of leads and tasks of all companies together, 1,440 times a day.
--
-- 1. enqueue_task_reminders: the time test sits inside a CASE, which no index can serve. Every run joined every open
--    task of every company to its lead and ran lead_task_owner() on it before the time test.
--    -> A plain time range now comes first: due_at in (now() - 1 hour, now() + 15 minutes]. That range is exactly the
--       union of the two CASE branches (due_soon: now() < due_at <= now() + 15 minutes; due_now:
--       now() - 1 hour < due_at <= now()), so the selected rows are identical. The CASE itself is unchanged.
--       New index lead_tasks_open_due_at_idx. The existing (tenant_id, due_at) index cannot serve a range across all
--       companies.
-- 2. backfill_missing_label_classifications: anti-joined every lead ever saved against its classification. It is the
--    safety net for the after-insert trigger create_lead_label_classification, which swallows its own errors so that a
--    lead save never fails.
--    -> The minute run checks only leads saved in the last hour. created_at is the save time: no save function sets it,
--       so it is always the column default now(). New index lead_data_saved_at_idx; the existing
--       (tenant_id, created_at) index cannot serve a range across all companies on PostgreSQL 17.
--    -> New backfill_all_missing_label_classifications(): the previous full check, statement unchanged, run once a
--       night by pg_cron (crm-label-classification-nightly-backfill).
-- 3. recover_meta_ad_name_resolutions, second statement: filled lead_data.ad_name from resolved ads by scanning every
--    lead without an ad name (no index; call-in, Google Ads and webhook leads never have one).
--    complete_meta_ad_name_resolution already fills every existing lead of an ad when its name is fetched, and a new
--    lead copies the stored name when it is saved (complete_meta_lead_retrieval_event). This statement only catches a
--    lead saved in the same moment as its ad's name.
--    -> The minute run checks only leads saved in the last hour (same lead_data_saved_at_idx).
--       `lead.ad_id is not null` is spelled out; a lead without an ad never matched the join, so no row changes.
--    -> New backfill_all_missing_lead_ad_names(): the previous full statement, unchanged, run once a night by pg_cron
--       (crm-lead-ad-names-nightly-backfill).
-- 4. Stuck-item checks, statements unchanged. Their cutoff uses clock_timestamp(), which no index condition can use,
--    so these small partial indexes hold only the rows the check can touch:
--    - lead_label_classifications_lease_idx and meta_ads_lease_idx: only rows a worker currently holds. They replace a
--      full scan of the table (one row per lead / per ad) with a scan of the leased rows (at most a few dozen).
--    - lead_label_classifications_requeue_idx: only failed AI labels that may still be retried. The existing
--      lead_label_classifications_failed_idx also holds labels that stopped retrying for good (requeue_count >= 48),
--      and that list only ever grows.
--
-- Identical: reminders (same rows, same minute), stuck-item recovery, AI-label and ad-name claims, every function name
-- and argument list (the app calls them by name; a new argument would create a second function and break that call),
-- owners, SECURITY DEFINER, search_path, existing grants. The cron jobs, worker routes and app code are not touched.
-- Bounded on purpose: the two safety nets (2 and 3) check the last hour every minute and every lead once a night.
-- They only matter when the label trigger failed or a lead raced its ad-name fetch. If the minute jobs cannot run for
-- more than an hour (a Vercel or pg_net outage), such a lead is caught that night instead of in the next minute.
--
-- Nightly jobs run in UTC (cron.timezone = GMT on this project): 21:00 UTC = 02:30 IST and 21:15 UTC = 02:45 IST.
-- They run as postgres (owner of both functions). New functions are executable by service_role only: Supabase's
-- default privileges would otherwise let anon and authenticated call a whole-table sweep through the API.
--
-- Locks: each create index blocks writes to its table while it builds (38 leads, 34 MB database on 2026-11-14, so
-- milliseconds). A lead saved in that moment waits, then saves; it is never rejected. lock_timeout makes the migration
-- fail and roll back cleanly, changing nothing, instead of queueing lead saves behind a long query.
-- Undo: supabase/rollbacks/20261114120000_minute_jobs_read_only_waiting_rows.rollback.sql.

begin;
set local lock_timeout = '5s';

-- Indexes -------------------------------------------------------------------------------------------------------------

create index if not exists lead_tasks_open_due_at_idx
  on public.lead_tasks (due_at)
  where status = 'open';

create index if not exists lead_data_saved_at_idx
  on public.lead_data (created_at);

create index if not exists lead_label_classifications_lease_idx
  on public.lead_label_classifications (lease_expires_at)
  where claim_token is not null;

create index if not exists lead_label_classifications_requeue_idx
  on public.lead_label_classifications (updated_at)
  where status = 'failed' and label_source <> 'telecaller' and requeue_count < 48;

create index if not exists meta_ads_lease_idx
  on public.meta_ads (lease_expires_at)
  where claim_token is not null;

-- 1. Task reminders ---------------------------------------------------------------------------------------------------

create or replace function public.enqueue_task_reminders(p_tenant_id uuid default null)
returns setof public.task_notifications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.task_notifications;
begin
  for v_row in
    insert into public.task_notifications (tenant_id, user_id, task_id, lead_id, kind, due_at)
    select t.tenant_id, o.owner_id, t.id, t.lead_id, k.kind, t.due_at
    from public.lead_tasks as t
    join public.lead_data as l on l.tenant_id = t.tenant_id and l.id = t.lead_id
    cross join lateral (select public.lead_task_owner(t.tenant_id, l.assigned_user_id, t.created_by) as owner_id) as o
    cross join (values ('due_soon'), ('due_now')) as k(kind)
    where t.status = 'open'
      -- Exactly the union of the two CASE branches below, written so lead_tasks_open_due_at_idx can serve it.
      and t.due_at > now() - interval '1 hour'
      and t.due_at <= now() + interval '15 minutes'
      and (p_tenant_id is null or t.tenant_id = p_tenant_id)
      and o.owner_id is not null
      and case k.kind
        when 'due_soon' then t.due_at - interval '15 minutes' <= now() and now() < t.due_at
        else t.due_at <= now() and t.due_at > now() - interval '1 hour'
      end
    on conflict do nothing
    returning *
  loop
    perform realtime.send(
      pg_catalog.jsonb_build_object('notification_id', v_row.id, 'user_id', v_row.user_id),
      'task_reminder', 'dashboard:' || v_row.tenant_id::text, true
    );
    return next v_row;
  end loop;
end;
$$;

-- 2. AI-label safety net ----------------------------------------------------------------------------------------------

-- Every minute (called by the label-classification worker): leads saved in the last hour only.
create or replace function public.backfill_missing_label_classifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare inserted integer;
begin
  insert into public.lead_label_classifications (tenant_id, lead_id, final_label, label_source, status, next_retry_at)
  select lead.tenant_id, lead.id, lead.label, lead.label_source,
    case when lead.label_source = 'telecaller' then 'completed' else 'pending' end,
    case when lead.label_source = 'telecaller' then null else clock_timestamp() end
  from public.lead_data as lead
  left join public.lead_label_classifications as classification on classification.lead_id = lead.id
  where classification.lead_id is null
    and lead.created_at >= now() - interval '1 hour'
  on conflict (lead_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- Once a night (pg_cron): every lead, the previous minute statement unchanged.
create or replace function public.backfill_all_missing_label_classifications()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare inserted integer;
begin
  insert into public.lead_label_classifications (tenant_id, lead_id, final_label, label_source, status, next_retry_at)
  select lead.tenant_id, lead.id, lead.label, lead.label_source,
    case when lead.label_source = 'telecaller' then 'completed' else 'pending' end,
    case when lead.label_source = 'telecaller' then null else clock_timestamp() end
  from public.lead_data as lead
  left join public.lead_label_classifications as classification on classification.lead_id = lead.id
  where classification.lead_id is null
  on conflict (lead_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

revoke all on function public.backfill_all_missing_label_classifications() from public, anon, authenticated;
grant execute on function public.backfill_all_missing_label_classifications() to service_role;

-- 3. Ad-name safety net -----------------------------------------------------------------------------------------------

-- Every minute (called by the Facebook recovery worker): expired leases as before; the ad-name fill for leads saved in
-- the last hour only.
create or replace function public.recover_meta_ad_name_resolutions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare recovered integer;
begin
  update public.meta_ads set resolution_status = 'transient_error', claim_token = null,
    lease_expires_at = null, next_retry_at = clock_timestamp(),
    last_error_code = 'WORKER_LEASE_EXPIRED', last_error_message = 'The ad-name resolver lease expired before completion.'
  where claim_token is not null and lease_expires_at <= clock_timestamp();
  get diagnostics recovered = row_count;
  update public.lead_data as lead set ad_name = mapping.ad_name
  from public.meta_ads as mapping
  where lead.tenant_id = mapping.tenant_id and lead.ad_id = mapping.ad_id
    and lead.ad_name is null and mapping.resolution_status = 'resolved'
    and mapping.ad_name is not null
    and lead.ad_id is not null
    and lead.created_at >= now() - interval '1 hour';
  return recovered;
end;
$$;

-- Once a night (pg_cron): every lead, the previous fill statement unchanged.
create or replace function public.backfill_all_missing_lead_ad_names()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare filled integer;
begin
  update public.lead_data as lead set ad_name = mapping.ad_name
  from public.meta_ads as mapping
  where lead.tenant_id = mapping.tenant_id and lead.ad_id = mapping.ad_id
    and lead.ad_name is null and mapping.resolution_status = 'resolved'
    and mapping.ad_name is not null;
  get diagnostics filled = row_count;
  return filled;
end;
$$;

revoke all on function public.backfill_all_missing_lead_ad_names() from public, anon, authenticated;
grant execute on function public.backfill_all_missing_lead_ad_names() to service_role;

-- Nightly jobs --------------------------------------------------------------------------------------------------------

-- cron.schedule upserts by job name, so re-running this never duplicates a job. crm-cron-history-cleanup already
-- clears the run history of every crm-% job.
select cron.schedule('crm-label-classification-nightly-backfill', '0 21 * * *',
  $$ select public.backfill_all_missing_label_classifications() $$);
select cron.schedule('crm-lead-ad-names-nightly-backfill', '15 21 * * *',
  $$ select public.backfill_all_missing_lead_ad_names() $$);

commit;

-- Undo 20261114120000_minute_jobs_read_only_waiting_rows.sql. It puts back the three every-minute functions exactly as
-- they ran on production before it (pg_get_functiondef on 2026-11-14), stops and removes the two nightly jobs and
-- their functions, and drops the five indexes. Names, arguments, owners and grants of the three restored functions
-- never changed, so the worker routes keep working throughout.

begin;
set local lock_timeout = '5s';

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
  on conflict (lead_id) do nothing;
  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

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
    and mapping.ad_name is not null;
  return recovered;
end;
$$;

-- cron.unschedule raises an error for an unknown name, so only existing jobs are passed to it.
select cron.unschedule(jobname) from cron.job
where jobname in ('crm-label-classification-nightly-backfill', 'crm-lead-ad-names-nightly-backfill');

drop function if exists public.backfill_all_missing_label_classifications();
drop function if exists public.backfill_all_missing_lead_ad_names();

drop index if exists public.lead_tasks_open_due_at_idx;
drop index if exists public.lead_data_saved_at_idx;
drop index if exists public.lead_label_classifications_lease_idx;
drop index if exists public.lead_label_classifications_requeue_idx;
drop index if exists public.meta_ads_lease_idx;

commit;

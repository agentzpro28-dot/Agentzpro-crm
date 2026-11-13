-- /leads and Dashboard Ad filter: list every ad that has a lead, without reading lead rows.
--
-- getLeadFilterOptions built the Ad list from the newest 500 lead rows, so an ad whose leads were all older than those
-- 500 disappeared from the filter, and 500 rows were sent to build a short list. This function returns each ad that
-- has at least one lead (optionally on one Page) with its newest lead's ad name and time: the same answer the 500-row
-- read gave, without the cap. The app orders the rows (newest first) before the API's row cap.
--
-- It steps from one ad to the next on lead_data_tenant_ad_created_idx (tenant_id, ad_id, lead_created_time desc,
-- id desc) where ad_id is not null, then reads each ad's newest lead from the same index, so without a Page its cost
-- grows with the number of ads, not the number of leads. With a Page, an ad with no lead on that Page is checked
-- through its own leads before it is left out (bounded by that ad's leads; one ad rarely runs on several Pages).
-- Read-only and new: nothing existing changes, no table is locked.
--
-- ORDER: apply this first, then deploy the code that calls it (localhost uses the live database too).
-- Undo: supabase/rollbacks/20261113122000_lead_filter_ads.rollback.sql (only after the calling code is reverted).

begin;

create or replace function public.list_lead_filter_ads(p_tenant_id uuid, p_page_record_id uuid default null)
returns table (ad_id text, ad_name text, newest_lead_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with recursive ads as (
    (select l.ad_id from public.lead_data l
      where l.tenant_id = p_tenant_id and l.ad_id is not null
      order by l.ad_id limit 1)
    union all
    select (select l.ad_id from public.lead_data l
             where l.tenant_id = p_tenant_id and l.ad_id is not null and l.ad_id > ads.ad_id
             order by l.ad_id limit 1)
    from ads
    where ads.ad_id is not null
  )
  select a.ad_id, newest.ad_name, newest.lead_created_time
  from ads a
  cross join lateral (
    select l.ad_name, l.lead_created_time from public.lead_data l
    where l.tenant_id = p_tenant_id and l.ad_id = a.ad_id
      and (p_page_record_id is null or l.facebook_page_record_id = p_page_record_id)
    order by l.lead_created_time desc, l.id desc
    limit 1
  ) newest
  where a.ad_id is not null;
$$;

revoke all on function public.list_lead_filter_ads(uuid, uuid) from public, anon, authenticated;
grant execute on function public.list_lead_filter_ads(uuid, uuid) to service_role;

commit;

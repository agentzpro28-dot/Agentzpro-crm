-- Undo 20261113122000_lead_filter_ads.sql. Revert the getLeadFilterOptions code first (it calls this function), then:

begin;

drop function if exists public.list_lead_filter_ads(uuid, uuid);

commit;

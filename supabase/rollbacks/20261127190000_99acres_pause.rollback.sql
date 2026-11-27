-- Undo 20261127190000_99acres_pause.sql. Deploy the app without 99acres Pause first: the Pause app reads paused_at.
-- A paused 99acres URL starts receiving leads again once this runs.
begin;
set local lock_timeout = '5s';

create or replace function public.find_portal_integration(p_portal text, p_token_hash text)
 returns table(id uuid, tenant_id uuid, portal_name text, field_mapping jsonb, url_version text)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.tenant_id, i.portal_name, i.field_mapping, 'current'::text
  from public.portal_integrations as i
  where i.url_token_hash = p_token_hash and i.portal_name = p_portal and i.is_active
  union all
  select i.id, i.tenant_id, i.portal_name, i.field_mapping, 'previous'::text
  from public.portal_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.portal_name = p_portal
    and i.previous_valid_until > pg_catalog.now() and i.is_active
  limit 1;
$function$;

alter table public.portal_integrations drop column if exists paused_at;
commit;

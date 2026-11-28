-- Undo 20261127200000_magicbricks_pause.sql. Deploy the app without MagicBricks Pause first: the Pause app reads
-- paused_at. A paused MagicBricks URL starts receiving leads again once this runs.
begin;
set local lock_timeout = '5s';

create or replace function public.find_magicbricks_integration(p_token_hash text)
 returns table(id uuid, tenant_id uuid, field_mapping jsonb, url_version text)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.tenant_id, i.field_mapping, 'current'::text
  from public.magicbricks_integrations as i
  where i.url_token_hash = p_token_hash and i.is_active
  union all
  select i.id, i.tenant_id, i.field_mapping, 'previous'::text
  from public.magicbricks_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now() and i.is_active
  limit 1;
$function$;

alter table public.magicbricks_integrations drop column if exists paused_at;
commit;

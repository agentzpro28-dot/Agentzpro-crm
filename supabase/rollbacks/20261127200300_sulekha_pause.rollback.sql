-- Undo 20261127200300_sulekha_pause.sql. Deploy the app without Sulekha Pause first: the Pause app reads paused_at.
-- A paused Sulekha URL starts receiving leads again once this runs.
begin;
set local lock_timeout = '5s';

create or replace function public.find_sulekha_integration(p_token_hash text)
 returns table(id uuid, tenant_id uuid, field_mapping jsonb, url_version text)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.tenant_id, i.field_mapping, 'current'::text
  from public.sulekha_integrations as i
  where i.url_token_hash = p_token_hash and i.is_active
  union all
  select i.id, i.tenant_id, i.field_mapping, 'previous'::text
  from public.sulekha_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now() and i.is_active
  limit 1;
$function$;

alter table public.sulekha_integrations drop column if exists paused_at;
commit;

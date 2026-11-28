-- MagicBricks: Pause / Resume (owner only). While paused_at is set, every request to this company's MagicBricks URLs
-- (the current URL and the old URL during its 7 days) is refused with 404 "Unknown webhook.", like a wrong URL: nothing
-- is read, logged or saved. Resume clears paused_at.
--
-- MagicBricks objects only: magicbricks_integrations and find_magicbricks_integration. Nothing of 99acres, Housing.com,
-- NoBroker, Sulekha, OLX Home, the custom webhook, Facebook or Google Ads is read or changed. lead_data is not altered.
--
-- find_magicbricks_integration is re-created exactly as live (copied from prod with pg_get_functiondef), plus
-- "and i.paused_at is null" on both lines. Same signature, so the running app keeps working; CREATE OR REPLACE keeps
-- its grants (postgres and service_role only). save_magicbricks_url lists the columns it changes on a regenerate and
-- paused_at is not one of them, so a paused URL stays paused after Regenerate until the owner clicks Resume.
--
-- Existing rows: paused_at starts NULL (receiving), so MagicBricks behaves exactly as before until an owner pauses.
-- Undo: supabase/rollbacks/20261127200000_magicbricks_pause.rollback.sql. Check: scripts/sql/magicbricks-pause-verify.sql.
--
-- Locks: adding a nullable column with no default is a catalog-only change (milliseconds). lock_timeout makes it fail
-- and roll back cleanly instead of queueing MagicBricks requests behind a long query.

begin;
set local lock_timeout = '5s';

alter table public.magicbricks_integrations add column paused_at timestamptz;
comment on column public.magicbricks_integrations.paused_at is
  'When the owner paused MagicBricks leads (Integrations card). NULL = receiving. While set, find_magicbricks_integration finds nothing, so every request gets 404.';

create or replace function public.find_magicbricks_integration(p_token_hash text)
 returns table(id uuid, tenant_id uuid, field_mapping jsonb, url_version text)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.tenant_id, i.field_mapping, 'current'::text
  from public.magicbricks_integrations as i
  where i.url_token_hash = p_token_hash and i.is_active and i.paused_at is null
  union all
  select i.id, i.tenant_id, i.field_mapping, 'previous'::text
  from public.magicbricks_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now() and i.is_active and i.paused_at is null
  limit 1;
$function$;

commit;

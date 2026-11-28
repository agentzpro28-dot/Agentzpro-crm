-- NoBroker: Pause / Resume (owner only). While paused_at is set, every request to this company's NoBroker URLs (the
-- current URL and the old URL during its 7 days) is refused with 404 "Unknown webhook.", like a wrong URL: nothing is
-- read, logged or saved. Resume clears paused_at.
--
-- NoBroker objects only: nobroker_integrations and find_nobroker_integration. Nothing of 99acres, MagicBricks,
-- Housing.com, Sulekha, OLX Home, the custom webhook, Facebook or Google Ads is read or changed. lead_data is not altered.
--
-- find_nobroker_integration is re-created exactly as live (copied from prod with pg_get_functiondef), plus
-- "and i.paused_at is null" on both lines. Same signature, so the running app keeps working; CREATE OR REPLACE keeps
-- its grants (postgres + service_role only). save_nobroker_url lists the columns it changes on a regenerate and
-- paused_at is not one of them, so a paused URL stays paused after Regenerate until the owner clicks Resume.
--
-- Existing rows: paused_at starts NULL (receiving), so NoBroker behaves exactly as before until an owner pauses.
-- Undo: supabase/rollbacks/20261127200200_nobroker_pause.rollback.sql. Check: scripts/sql/nobroker-pause-verify.sql.

begin;
set local lock_timeout = '5s';

alter table public.nobroker_integrations add column paused_at timestamptz;
comment on column public.nobroker_integrations.paused_at is
  'When the owner paused NoBroker leads (Integrations card). NULL = receiving. While set, find_nobroker_integration finds nothing, so every request gets 404.';

create or replace function public.find_nobroker_integration(p_token_hash text)
 returns table(id uuid, tenant_id uuid, field_mapping jsonb, url_version text)
 language sql
 stable security definer
 set search_path to ''
as $function$
  select i.id, i.tenant_id, i.field_mapping, 'current'::text
  from public.nobroker_integrations as i
  where i.url_token_hash = p_token_hash and i.is_active and i.paused_at is null
  union all
  select i.id, i.tenant_id, i.field_mapping, 'previous'::text
  from public.nobroker_integrations as i
  where i.previous_url_token_hash = p_token_hash and i.previous_valid_until > pg_catalog.now() and i.is_active and i.paused_at is null
  limit 1;
$function$;

commit;

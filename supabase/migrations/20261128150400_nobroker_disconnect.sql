-- NoBroker: Disconnect (owner only). The owner's Disconnect sets is_active = false and clears the pause and the old URL
-- in one UPDATE (nobroker-integration-service.ts). find_nobroker_integration (current URL and old URL) and
-- ingest_nobroker_lead already require is_active, so from that moment every request to this company's NoBroker URLs
-- gets 404 "Unknown webhook." and nothing is saved. The row is kept: leads already received point to it
-- (lead_data.nobroker_integration_id) and NoBroker stays in the /leads Source filter and the dashboard switch.
--
-- This migration closes the one gap: connecting again (save_nobroker_url on a disconnected row) used to make the
-- disconnected URL the old URL for 7 more days. Now a disconnected URL is never carried over, and a reconnect starts
-- unpaused with no old URL. For an active row nothing changes: Regenerate keeps the pause and the 7-day old URL as before.
--
-- NoBroker objects only: nobroker_integrations and save_nobroker_url. Nothing of 99acres, MagicBricks, Housing.com,
-- Sulekha, OLX Home, the custom webhook, Facebook or Google Ads is read or changed. lead_data is not altered.
--
-- save_nobroker_url is re-created exactly as live (copied from prod with pg_get_functiondef on 2026-11-28), plus the
-- three "case when i.is_active" lines. Same signature, so the running app keeps working; CREATE OR REPLACE keeps its
-- grants. Its own "on conflict (tenant_id)" and its own "replaced" expression stay as live.
-- In ON CONFLICT DO UPDATE, i.* is the existing row before the update, so i.is_active is its state before this save.
--
-- nobroker_integrations_disconnected_check makes the database itself refuse a disconnected row that still has an old
-- URL or a pause. The app live today never sets is_active = false on nobroker_integrations, so every row is active and
-- validating it passes.
--
-- Safe before the app deploy: for every row (all active) the new lines give the same values as before.
-- Undo: supabase/rollbacks/20261128150400_nobroker_disconnect.rollback.sql. Check: scripts/sql/nobroker-disconnect-verify.sql
-- and scripts/sql/nobroker-disconnect-scenario.sql.

begin;
set local lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.save_nobroker_url(p_tenant_id uuid, p_token_hash text, p_encrypted_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.nobroker_integrations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(p_encrypted_token, '') = '' then
    raise exception 'Malformed URL token' using errcode = '22023';
  end if;
  insert into public.nobroker_integrations as i (tenant_id, url_token_hash, encrypted_url_token)
  values (p_tenant_id, p_token_hash, p_encrypted_token)
  on conflict (tenant_id) do update set
    -- A disconnected URL never becomes the old URL: after a Disconnect only the new URL works.
    previous_url_token_hash = case when i.is_active then i.url_token_hash end,
    previous_valid_until = case when i.is_active then pg_catalog.now() + interval '7 days' end,
    previous_last_received_at = null,
    url_token_hash = excluded.url_token_hash,
    encrypted_url_token = excluded.encrypted_url_token,
    last_received_at = null,
    -- Regenerate keeps a pause; connecting again after a Disconnect starts receiving at once.
    paused_at = case when i.is_active then i.paused_at end,
    is_active = true,
    url_rotated_at = pg_catalog.now()
  returning * into v_row;
  return pg_catalog.jsonb_build_object('replaced', v_row.url_rotated_at is not null and v_row.previous_url_token_hash is not null,
    'previous_valid_until', v_row.previous_valid_until);
end;
$function$;

alter table public.nobroker_integrations add constraint nobroker_integrations_disconnected_check
  check (is_active or (previous_url_token_hash is null and previous_valid_until is null and paused_at is null)) not valid;

notify pgrst, 'reload schema';

commit;

-- Outside the transaction: validate against every existing row (all active, so all pass). SHARE UPDATE EXCLUSIVE:
-- NoBroker reads and writes continue.
alter table public.nobroker_integrations validate constraint nobroker_integrations_disconnected_check;

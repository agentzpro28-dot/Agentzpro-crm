-- Undo 20261128150200_housing_disconnect.sql. Deploy the app without Housing.com Disconnect first: that app never sets
-- is_active = false. A Housing.com URL disconnected before this runs stays refused (is_active stays false) until the owner
-- generates a new URL; after this rollback that reconnect would again keep the disconnected URL as the old URL for
-- 7 days, as before the migration.
begin;
set local lock_timeout = '5s';

alter table public.housing_integrations drop constraint if exists housing_integrations_disconnected_check;

CREATE OR REPLACE FUNCTION public.save_housing_url(p_tenant_id uuid, p_token_hash text, p_encrypted_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_row public.housing_integrations;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or coalesce(p_encrypted_token, '') = '' then
    raise exception 'Malformed URL token' using errcode = '22023';
  end if;
  insert into public.housing_integrations as i (tenant_id, url_token_hash, encrypted_url_token)
  values (p_tenant_id, p_token_hash, p_encrypted_token)
  on conflict (tenant_id) do update set
    previous_url_token_hash = i.url_token_hash,
    previous_valid_until = pg_catalog.now() + interval '7 days',
    previous_last_received_at = null,
    url_token_hash = excluded.url_token_hash,
    encrypted_url_token = excluded.encrypted_url_token,
    last_received_at = null,
    is_active = true,
    url_rotated_at = pg_catalog.now()
  returning * into v_row;
  return pg_catalog.jsonb_build_object('replaced', v_row.url_rotated_at is not null and v_row.previous_url_token_hash is not null,
    'previous_valid_until', v_row.previous_valid_until);
end;
$function$;

notify pgrst, 'reload schema';

commit;

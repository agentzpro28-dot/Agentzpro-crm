-- Scenario check for supabase/migrations/20261128150300_sulekha_disconnect.sql (Sulekha Disconnect): runs the real
-- Sulekha database functions on a temporary company that exists only inside this transaction, then rolls everything
-- back (begin ... rollback), so nothing stays and no real company's row is read or changed. Run only after the
-- migration is applied. Each check raises an exception on failure; reaching the final notice means every check passed.
--
-- The Disconnect step runs the same UPDATE the app sends (SulekhaIntegrationService.disconnect).

begin;

do $$
declare
  v_tenant uuid;
  h1 text := pg_catalog.repeat('1', 64);
  h2 text := pg_catalog.repeat('2', 64);
  h3 text := pg_catalog.repeat('3', 64);
  h4 text := pg_catalog.repeat('4', 64);
  v_integration uuid;
  v_row public.sulekha_integrations;
  v_match record;
  v_log uuid;
  v_result jsonb;
  v_count integer;
begin
  insert into public.tenants (tenant_name, timezone) values ('Disconnect scenario (rolled back)', 'Asia/Kolkata')
  returning tenant_id into v_tenant;

  -- 1. First Generate with no row yet: one active, unpaused integration with no old URL (unchanged behaviour).
  v_result := public.save_sulekha_url(v_tenant, h1, 'enc-1');
  select * into v_row from public.sulekha_integrations where tenant_id = v_tenant;
  v_integration := v_row.id;
  if (v_result->>'replaced')::boolean then raise exception '1: a first URL must not count as replaced'; end if;
  if not v_row.is_active or v_row.paused_at is not null or v_row.previous_url_token_hash is not null then
    raise exception '1: a first URL must be active, unpaused, with no old URL';
  end if;
  select * into v_match from public.find_sulekha_integration(h1);
  if v_match.url_version is distinct from 'current' then raise exception '1: new URL not found as current'; end if;

  -- 2. Regenerate on an active, unpaused row: old URL kept for 7 days, still unpaused (unchanged behaviour).
  v_result := public.save_sulekha_url(v_tenant, h2, 'enc-2');
  select * into v_row from public.sulekha_integrations where id = v_integration;
  if not (v_result->>'replaced')::boolean then raise exception '2: a regenerate must count as replaced'; end if;
  if v_row.previous_url_token_hash is distinct from h1 or v_row.paused_at is not null
      or v_row.previous_valid_until not between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute' then
    raise exception '2: regenerate must keep the old URL for 7 days and stay unpaused';
  end if;
  select * into v_match from public.find_sulekha_integration(h1);
  if v_match.url_version is distinct from 'previous' then raise exception '2: old URL must resolve as previous'; end if;

  -- 3. Regenerate on an active, paused row: the pause stays and the old URL is kept for 7 days (unchanged behaviour).
  update public.sulekha_integrations set paused_at = now() where id = v_integration;
  v_result := public.save_sulekha_url(v_tenant, h3, 'enc-3');
  select * into v_row from public.sulekha_integrations where id = v_integration;
  if v_row.paused_at is null then raise exception '3: regenerate must keep the pause'; end if;
  if v_row.previous_url_token_hash is distinct from h2
      or v_row.previous_valid_until not between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute' then
    raise exception '3: regenerate while paused must keep the old URL for 7 days';
  end if;
  update public.sulekha_integrations set paused_at = null where id = v_integration;
  select * into v_match from public.find_sulekha_integration(h2);
  if v_match.url_version is distinct from 'previous' then raise exception '3: old URL must resolve as previous after resume'; end if;

  -- 4. The database refuses a disconnected row that still has an old URL or a pause.
  begin
    update public.sulekha_integrations set is_active = false where id = v_integration;
    raise exception '4: a disconnected row with an old URL must be refused';
  exception when check_violation then null;
  end;

  -- 5. Disconnect (the app's UPDATE): neither the current nor the old URL resolves, and a save already past the lookup
  -- is refused (P0002), so nothing is saved.
  update public.sulekha_integrations
  set is_active = false, paused_at = null, previous_url_token_hash = null, previous_valid_until = null, previous_last_received_at = null
  where tenant_id = v_tenant;
  select count(*) into v_count from public.find_sulekha_integration(h3);
  if v_count <> 0 then raise exception '5: a disconnected current URL must not resolve'; end if;
  select count(*) into v_count from public.find_sulekha_integration(h2);
  if v_count <> 0 then raise exception '5: a disconnected old URL must not resolve'; end if;
  insert into public.sulekha_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  begin
    perform public.ingest_sulekha_lead(v_tenant, v_integration, v_log, h3, 'DSC-1', null, null,
      '[{"name":"phone_number","values":["9000000093"]}]'::jsonb, '{}'::jsonb);
    raise exception '5: a save on a disconnected URL must be refused';
  exception when sqlstate 'P0002' then null;
  end;
  if exists (select 1 from public.lead_data where tenant_id = v_tenant) then raise exception '5: a disconnected URL must save no lead'; end if;
  -- Still counted for the Source filter (the row stays).
  if not exists (select 1 from public.sulekha_integrations where tenant_id = v_tenant) then
    raise exception '5: the row must stay after Disconnect';
  end if;

  -- 6. Connect again: a brand-new URL, active and unpaused, with no old URL; the disconnected URLs stay refused.
  v_result := public.save_sulekha_url(v_tenant, h4, 'enc-4');
  select * into v_row from public.sulekha_integrations where id = v_integration;
  if (v_result->>'replaced')::boolean then raise exception '6: connecting again must not count as replaced'; end if;
  if not v_row.is_active or v_row.paused_at is not null or v_row.previous_url_token_hash is not null or v_row.previous_valid_until is not null then
    raise exception '6: connecting again must be active, unpaused, with no old URL';
  end if;
  select * into v_match from public.find_sulekha_integration(h4);
  if v_match.url_version is distinct from 'current' then raise exception '6: the new URL must resolve as current'; end if;
  select count(*) into v_count from public.find_sulekha_integration(h3);
  if v_count <> 0 then raise exception '6: the disconnected URL must stay refused'; end if;
  select count(*) into v_count from public.find_sulekha_integration(h2);
  if v_count <> 0 then raise exception '6: the old disconnected URL must stay refused'; end if;

  -- 7. The new URL saves a lead (inside this transaction only).
  insert into public.sulekha_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_sulekha_lead(v_tenant, v_integration, v_log, h4, 'DSC-2', null, null,
    '[{"name":"phone_number","values":["9000000094"]}]'::jsonb, '{}'::jsonb);
  if v_result->>'outcome' <> 'stored' then raise exception '7: expected stored on the new URL, got %', v_result; end if;

  raise notice 'sulekha-disconnect-scenario: all 7 checks passed (rolled back, nothing kept)';
end;
$$;

rollback;

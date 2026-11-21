-- Scenario check for supabase/migrations/20261121120000_99acres_previous_url.sql (99acres 7-day old URL): runs the real
-- 99acres database functions on one TEST company and then rolls everything back (begin ... rollback), so nothing stays.
-- Run only after the migration is applied, only on the owner's OK, and only with a test company's tenant id (never
-- BRIQ FOUNDATION). Each check raises an exception on failure; reaching the final notice means every check passed.
--
-- Before running: replace TEST_TENANT_ID below (one place) with the test company's tenant_id.

begin;

create temporary table scenario_input on commit drop as select 'TEST_TENANT_ID'::uuid as tenant_id;

do $$
declare
  v_tenant uuid := (select tenant_id from scenario_input);
  h1 text := pg_catalog.repeat('a', 64);
  h2 text := pg_catalog.repeat('b', 64);
  h3 text := pg_catalog.repeat('c', 64);
  v_integration uuid;
  v_match record;
  v_log uuid;
  v_result jsonb;
  v_count integer;
begin
  if v_tenant::text like 'aaec9489%' then
    raise exception 'Refused: this is BRIQ FOUNDATION (real leads). Use a test company.';
  end if;
  if not exists (select 1 from public.tenants where tenant_id = v_tenant) then
    raise exception 'Unknown tenant %', v_tenant;
  end if;
  if exists (select 1 from public.portal_integrations where tenant_id = v_tenant and portal_name = '99acres') then
    raise exception 'This company already has a 99acres integration; use a company without one.';
  end if;

  -- 1. Create the URL: one integration, no old URL.
  v_result := public.save_portal_url(v_tenant, '99acres', h1, 'enc-1');
  select id into v_integration from public.portal_integrations where tenant_id = v_tenant and portal_name = '99acres';
  if (v_result->>'replaced')::boolean then raise exception '1: a first URL must not count as replaced'; end if;
  select * into v_match from public.find_portal_integration('99acres', h1);
  if v_match.url_version is distinct from 'current' or v_match.id <> v_integration then raise exception '1: new URL not found as current'; end if;

  -- 2. Regenerate: the old URL still resolves, as previous, for 7 days; the new URL waits for its first lead.
  update public.portal_integrations set last_received_at = now() where id = v_integration;
  v_result := public.save_portal_url(v_tenant, '99acres', h2, 'enc-2');
  if not (v_result->>'replaced')::boolean then raise exception '2: a regenerate must count as replaced'; end if;
  select * into v_match from public.find_portal_integration('99acres', h1);
  if v_match.url_version is distinct from 'previous' then raise exception '2: old URL must resolve as previous'; end if;
  select * into v_match from public.find_portal_integration('99acres', h2);
  if v_match.url_version is distinct from 'current' then raise exception '2: new URL must resolve as current'; end if;
  if not exists (select 1 from public.portal_integrations where id = v_integration and last_received_at is null
      and previous_valid_until between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute') then
    raise exception '2: old URL must be valid for 7 days and the new URL must wait for its first lead';
  end if;
  select count(*) into v_count from public.find_portal_integration('magicbricks', h1);
  if v_count <> 0 then raise exception '2: a 99acres URL must never resolve for another portal'; end if;

  -- 3. A lead on the old URL is saved and timed on the old URL only: the new URL never looks Connected because of it.
  insert into public.portal_webhook_logs (tenant_id, integration_id, portal_name, http_method, url_version, raw_body)
  values (v_tenant, v_integration, '99acres', 'POST', 'previous', '{}') returning id into v_log;
  v_result := public.ingest_portal_lead_on_url(v_tenant, v_integration, v_log, '99acres', h1, 'SCN-1', 'Scenario Towers', 'New 99acres enquiry',
    '[{"name":"full_name","values":["Scenario Buyer"]},{"name":"phone_number","values":["+91 90000 00011"]}]'::jsonb, '{"scenario":true}'::jsonb, false);
  if v_result->>'outcome' <> 'stored' then raise exception '3: expected stored, got %', v_result; end if;
  if exists (select 1 from public.portal_integrations where id = v_integration and last_received_at is not null) then
    raise exception '3: a lead on the old URL must not set the new URL''s last lead time';
  end if;
  if not exists (select 1 from public.portal_integrations where id = v_integration and previous_last_received_at is not null) then
    raise exception '3: a lead on the old URL must set previous_last_received_at';
  end if;
  if not exists (select 1 from public.lead_data where id = (v_result->>'lead_id')::uuid and lead_source = '99acres'
      and portal_integration_id = v_integration and portal_lead_ref = 'SCN-1' and lead_platform = '99acres' and lead_phone_normalized = '919000000011') then
    raise exception '3: stored lead has the wrong columns';
  end if;

  -- 4. The same enquiry again, now on the new URL (a retry): duplicate, nothing new; the new URL is now Connected.
  insert into public.portal_webhook_logs (tenant_id, integration_id, portal_name, http_method, url_version, raw_body)
  values (v_tenant, v_integration, '99acres', 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_portal_lead_on_url(v_tenant, v_integration, v_log, '99acres', h2, 'SCN-1', null, null,
    '[{"name":"phone_number","values":["9000000011"]}]'::jsonb, '{}'::jsonb, false);
  if v_result->>'outcome' <> 'duplicate' then raise exception '4: expected duplicate, got %', v_result; end if;
  if not exists (select 1 from public.portal_integrations where id = v_integration and last_received_at is not null) then
    raise exception '4: a lead on the new URL must set last_received_at';
  end if;

  -- 5. The same phone, a new enquiry: merged as a timeline note, no second lead.
  insert into public.portal_webhook_logs (tenant_id, integration_id, portal_name, http_method, url_version, raw_body)
  values (v_tenant, v_integration, '99acres', 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_portal_lead_on_url(v_tenant, v_integration, v_log, '99acres', h2, 'SCN-2', null, 'New 99acres enquiry · Scenario',
    '[{"name":"phone_number","values":["09000000011"]}]'::jsonb, '{}'::jsonb, false);
  if v_result->>'outcome' <> 'merged' then raise exception '5: expected merged, got %', v_result; end if;

  -- 6. A test lead never sets either lead time.
  update public.portal_integrations set last_received_at = null, previous_last_received_at = null where id = v_integration;
  insert into public.portal_webhook_logs (tenant_id, integration_id, portal_name, http_method, url_version, raw_body)
  values (v_tenant, v_integration, '99acres', 'POST', 'previous', '{}') returning id into v_log;
  perform public.ingest_portal_lead_on_url(v_tenant, v_integration, v_log, '99acres', h1, 'SCN-3', null, null,
    '[{"name":"phone_number","values":["9000000012"]}]'::jsonb, '{}'::jsonb, true);
  if exists (select 1 from public.portal_integrations where id = v_integration and (last_received_at is not null or previous_last_received_at is not null)) then
    raise exception '6: a test lead must not set a lead time';
  end if;

  -- 7. The old URL expires: no row, and a save on it is refused (P0002).
  update public.portal_integrations set previous_valid_until = now() - interval '1 second' where id = v_integration;
  select count(*) into v_count from public.find_portal_integration('99acres', h1);
  if v_count <> 0 then raise exception '7: an expired old URL must not resolve'; end if;
  insert into public.portal_webhook_logs (tenant_id, integration_id, portal_name, http_method, url_version, raw_body)
  values (v_tenant, v_integration, '99acres', 'POST', 'previous', '{}') returning id into v_log;
  begin
    perform public.ingest_portal_lead_on_url(v_tenant, v_integration, v_log, '99acres', h1, null, null, null,
      '[{"name":"phone_number","values":["9000000019"]}]'::jsonb, '{}'::jsonb, false);
    raise exception '7: a save on an expired old URL must be refused';
  exception when sqlstate 'P0002' then null;
  end;

  -- 8. Two regenerates: only the last replaced URL works; the oldest ends at once.
  update public.portal_integrations set previous_valid_until = now() + interval '7 days' where id = v_integration;
  perform public.save_portal_url(v_tenant, '99acres', h3, 'enc-3');
  select count(*) into v_count from public.find_portal_integration('99acres', h1);
  if v_count <> 0 then raise exception '8: the oldest URL must end at once'; end if;
  select * into v_match from public.find_portal_integration('99acres', h2);
  if v_match.url_version is distinct from 'previous' then raise exception '8: the last replaced URL must resolve as previous'; end if;

  -- 9. A stopped integration accepts neither URL.
  update public.portal_integrations set is_active = false where id = v_integration;
  select count(*) into v_count from public.find_portal_integration('99acres', h2);
  if v_count <> 0 then raise exception '9: a stopped integration must not resolve its old URL'; end if;
  select count(*) into v_count from public.find_portal_integration('99acres', h3);
  if v_count <> 0 then raise exception '9: a stopped integration must not resolve its current URL'; end if;

  raise notice '99acres-previous-url-scenario: all 9 checks passed (rolled back, nothing kept)';
end;
$$;

rollback;

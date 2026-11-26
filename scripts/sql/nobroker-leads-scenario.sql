-- Scenario check for supabase/migrations/20261126120000_nobroker_leads.sql: runs the real NoBroker database functions
-- on one TEST company and then rolls everything back (begin ... rollback), so nothing stays. Run only after the
-- migration is applied, only on the owner's OK, and only with a test company's tenant id (never BRIQ FOUNDATION).
-- Each check raises an exception on failure; reaching the final notice means every check passed.
--
-- Before running: replace TEST_TENANT_ID below (one place) with the test company's tenant_id.

begin;

create temporary table scenario_input on commit drop as select 'TEST_TENANT_ID'::uuid as tenant_id;

do $$
declare
  v_tenant uuid := (select tenant_id from scenario_input);
  h1 text := pg_catalog.repeat('1', 64);
  h2 text := pg_catalog.repeat('2', 64);
  h3 text := pg_catalog.repeat('3', 64);
  v_integration uuid;
  v_match record;
  v_log uuid;
  v_result jsonb;
  v_lead uuid;
  v_count integer;
begin
  if v_tenant::text like 'aaec9489%' then
    raise exception 'Refused: this is BRIQ FOUNDATION (real leads). Use a test company.';
  end if;
  if not exists (select 1 from public.tenants where tenant_id = v_tenant) then
    raise exception 'Unknown tenant %', v_tenant;
  end if;
  if exists (select 1 from public.nobroker_integrations where tenant_id = v_tenant) then
    raise exception 'This company already has a NoBroker integration; use a company without one.';
  end if;

  -- 1. Create the URL: one integration, no old URL.
  v_result := public.save_nobroker_url(v_tenant, h1, 'enc-1');
  select id into v_integration from public.nobroker_integrations where tenant_id = v_tenant;
  if (v_result->>'replaced')::boolean then raise exception '1: a first URL must not count as replaced'; end if;
  select * into v_match from public.find_nobroker_integration(h1);
  if v_match.url_version is distinct from 'current' or v_match.id <> v_integration then raise exception '1: new URL not found as current'; end if;

  -- 2. Regenerate: the old URL still resolves, as previous, for 7 days.
  perform public.save_nobroker_url(v_tenant, h2, 'enc-2');
  select * into v_match from public.find_nobroker_integration(h1);
  if v_match.url_version is distinct from 'previous' then raise exception '2: old URL must resolve as previous'; end if;
  select * into v_match from public.find_nobroker_integration(h2);
  if v_match.url_version is distinct from 'current' then raise exception '2: new URL must resolve as current'; end if;
  if not exists (select 1 from public.nobroker_integrations where id = v_integration
      and previous_valid_until between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days' + interval '1 minute') then
    raise exception '2: old URL must be valid for 7 days';
  end if;

  -- 3. A lead on the old URL is timed on the old URL only: the new URL never looks Connected because of it.
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'previous', '{}') returning id into v_log;
  v_result := public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h1, 'SCN-1', 'Scenario Towers', 'New NoBroker enquiry',
    '[{"name":"full_name","values":["Scenario Buyer"]},{"name":"phone_number","values":["+91 90000 00001"]}]'::jsonb, '{"scenario":true}'::jsonb);
  if v_result->>'outcome' <> 'stored' then raise exception '3: expected stored, got %', v_result; end if;
  if exists (select 1 from public.nobroker_integrations where id = v_integration and last_received_at is not null) then
    raise exception '3: a lead on the old URL must not set the new URL''s last lead time';
  end if;
  if not exists (select 1 from public.nobroker_integrations where id = v_integration and previous_last_received_at is not null) then
    raise exception '3: a lead on the old URL must set previous_last_received_at';
  end if;
  if not exists (select 1 from public.lead_data where id = (v_result->>'lead_id')::uuid and lead_source = 'nobroker'
      and nobroker_integration_id = v_integration and nobroker_lead_ref = 'SCN-1' and lead_platform = 'nobroker' and lead_phone_normalized = '919000000001') then
    raise exception '3: stored lead has the wrong columns';
  end if;

  -- 4. The same enquiry again (a retry): duplicate, nothing new.
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h2, 'SCN-1', null, null,
    '[{"name":"phone_number","values":["9000000001"]}]'::jsonb, '{}'::jsonb);
  if v_result->>'outcome' <> 'duplicate' then raise exception '4: expected duplicate, got %', v_result; end if;

  -- 5. The same phone, a new enquiry: merged as a timeline note, no second lead.
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h2, 'SCN-2', null, 'New NoBroker enquiry · Scenario',
    '[{"name":"phone_number","values":["09000000001"]}]'::jsonb, '{}'::jsonb);
  if v_result->>'outcome' <> 'merged' then raise exception '5: expected merged, got %', v_result; end if;
  if not exists (select 1 from public.lead_activities where lead_id = (v_result->>'lead_id')::uuid and type = 'note_added'
      and metadata->>'source' = 'nobroker') then
    raise exception '5: merge note missing';
  end if;

  -- 6. A phone with no digits ("NA") plus an email: stored as a new lead, never merged on an empty phone.
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  v_result := public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h2, null, null, null,
    '[{"name":"phone_number","values":["NA"]},{"name":"email","values":["scenario-na@example.com"]}]'::jsonb, '{}'::jsonb);
  if v_result->>'outcome' <> 'stored' then raise exception '6: expected stored for an NA phone with email, got %', v_result; end if;

  -- 7. A phone with no digits and no email: refused as no contact (22023).
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'current', '{}') returning id into v_log;
  begin
    perform public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h2, null, null, null,
      '[{"name":"phone_number","values":["NA"]}]'::jsonb, '{}'::jsonb);
    raise exception '7: an NA phone without email must be refused';
  exception when sqlstate '22023' then null;
  end;

  -- 8. The old URL expires: no row, and a save on it is refused (P0002).
  update public.nobroker_integrations set previous_valid_until = now() - interval '1 second' where id = v_integration;
  select count(*) into v_count from public.find_nobroker_integration(h1);
  if v_count <> 0 then raise exception '8: an expired old URL must not resolve'; end if;
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body)
  values (v_tenant, v_integration, 'POST', 'previous', '{}') returning id into v_log;
  begin
    perform public.ingest_nobroker_lead(v_tenant, v_integration, v_log, h1, null, null, null,
      '[{"name":"phone_number","values":["9000000009"]}]'::jsonb, '{}'::jsonb);
    raise exception '8: a save on an expired old URL must be refused';
  exception when sqlstate 'P0002' then null;
  end;

  -- 9. Two regenerates: only the last replaced URL works; the oldest ends at once.
  perform public.save_nobroker_url(v_tenant, h3, 'enc-3');
  select count(*) into v_count from public.find_nobroker_integration(h1);
  if v_count <> 0 then raise exception '9: the oldest URL must end at once'; end if;
  select * into v_match from public.find_nobroker_integration(h2);
  if v_match.url_version is distinct from 'previous' then raise exception '9: the last replaced URL must resolve as previous'; end if;

  -- 10. Nightly purge: saved copies after 30 days, failed/stuck copies after 90 days.
  delete from public.nobroker_webhook_logs where integration_id = v_integration;
  insert into public.nobroker_webhook_logs (tenant_id, integration_id, http_method, url_version, raw_body, status, created_at) values
    (v_tenant, v_integration, 'POST', 'current', 'processed-29', 'processed', now() - interval '29 days'),
    (v_tenant, v_integration, 'POST', 'current', 'processed-31', 'processed', now() - interval '31 days'),
    (v_tenant, v_integration, 'POST', 'current', 'duplicate-31', 'duplicate', now() - interval '31 days'),
    (v_tenant, v_integration, 'POST', 'current', 'failed-89', 'failed', now() - interval '89 days'),
    (v_tenant, v_integration, 'POST', 'current', 'failed-91', 'failed', now() - interval '91 days'),
    (v_tenant, v_integration, 'POST', 'current', 'received-89', 'received', now() - interval '89 days'),
    (v_tenant, v_integration, 'POST', 'current', 'received-91', 'received', now() - interval '91 days');
  perform private.purge_nobroker_webhook_logs();
  if (select pg_catalog.array_agg(raw_body order by raw_body) from public.nobroker_webhook_logs where integration_id = v_integration)
      <> array['failed-89', 'processed-29', 'received-89'] then
    raise exception '10: purge kept the wrong rows: %', (select pg_catalog.array_agg(raw_body order by raw_body) from public.nobroker_webhook_logs where integration_id = v_integration);
  end if;

  raise notice 'nobroker-leads-scenario: all 10 checks passed (rolled back, nothing kept)';
end;
$$;

rollback;
